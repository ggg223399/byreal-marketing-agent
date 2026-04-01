import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  buildJudgePrompt,
  validateJudgeResult,
  judgeTweets,
  JUDGE_BATCH_SIZE,
  resetJudgeCircuitBreaker,
} from '../../engine/judge.js';
import type { JudgeConfig, RawTweet } from '../../engine/types.js';

const JUDGE_CONFIG: JudgeConfig = {
  rules: 'You are a signal analyst. Judge importance.',
  output_schema: {
    alertLevel: { type: 'enum', values: ['red', 'orange', 'yellow', 'none'], description: 'Alert level' },
    reasoning: { type: 'string', max_length: 200, description: 'Reasoning' },
  },
};

function makeTweet(id: string, content: string): RawTweet {
  return { id, author: '@test', content, url: `https://x.com/${id}`, created_at: Date.now() };
}

describe('judge', () => {
  beforeEach(() => {
    resetJudgeCircuitBreaker();
    vi.restoreAllMocks();
  });

  describe('buildJudgePrompt', () => {
    it('combines rules with single tweet content', () => {
      const tweet = makeTweet('1', 'Byreal is great');
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet]);
      expect(prompt.system).toContain('signal analyst');
      expect(prompt.user).toContain('Byreal is great');
      expect(prompt.user).toContain('@test');
      expect(prompt.user).toContain('id=1');
    });

    it('batches multiple tweets into one prompt', () => {
      const tweets = [makeTweet('1', 'tweet 1'), makeTweet('2', 'tweet 2')];
      const prompt = buildJudgePrompt(JUDGE_CONFIG, tweets);
      expect(prompt.user).toContain('tweet 1');
      expect(prompt.user).toContain('tweet 2');
      expect(prompt.user).toContain('2 tweets');
      expect(prompt.user).toContain('JSON object with a "results" array');
    });

    it('includes author follower count when available', () => {
      const tweet: RawTweet = { ...makeTweet('1', 'test'), metadata: { authorFollowers: 12500 } };
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet]);
      expect(prompt.user).toContain('followers: 12.5K');
    });

    it('includes engagement metrics when available', () => {
      const tweet: RawTweet = { ...makeTweet('1', 'test'), metrics: { likes: 500, retweets: 120, views: 8000 } };
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet]);
      expect(prompt.user).toContain('likes: 500');
      expect(prompt.user).toContain('retweets: 120');
      expect(prompt.user).toContain('views: 8000');
    });

    it('omits metrics line when all metrics are zero', () => {
      const tweet: RawTweet = { ...makeTweet('1', 'test'), metrics: { likes: 0, retweets: 0, views: 0 } };
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet]);
      expect(prompt.user).not.toContain('likes:');
    });

    it('includes source name when provided', () => {
      const tweet = makeTweet('1', 'test tweet');
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet], 'ecosystem-core');
      expect(prompt.user).toContain('source: ecosystem-core');
    });

    it('omits source tag when sourceName is not provided', () => {
      const tweet = makeTweet('1', 'test tweet');
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet]);
      expect(prompt.user).not.toContain('source:');
    });

    it('assembles only matching source_rules in dynamic trimming mode', () => {
      const config: JudgeConfig = {
        ...JUDGE_CONFIG,
        rules: 'You are a judge.',
        source_rules: {
          brand: 'Brand-specific rules here.',
          ecosystem: 'Ecosystem-specific rules here.',
        },
        source_category_map: {
          'direct-mentions': 'brand',
          'ecosystem-core': 'ecosystem',
        },
        author_rules: 'Author influence rules.',
      };
      const tweet = makeTweet('1', 'test');
      const prompt = buildJudgePrompt(config, [tweet], 'ecosystem-core');
      expect(prompt.system).toContain('You are a judge.');
      expect(prompt.system).toContain('Ecosystem-specific rules here.');
      expect(prompt.system).toContain('Author influence rules.');
      expect(prompt.system).not.toContain('Brand-specific rules here.');
    });

    it('falls back to rules-only when source not in category map', () => {
      const config: JudgeConfig = {
        ...JUDGE_CONFIG,
        rules: 'You are a judge.',
        source_rules: { brand: 'Brand rules.' },
        source_category_map: { 'direct-mentions': 'brand' },
        author_rules: 'Author rules.',
      };
      const tweet = makeTweet('1', 'test');
      const prompt = buildJudgePrompt(config, [tweet], 'unknown-source');
      expect(prompt.system).toContain('You are a judge.');
      expect(prompt.system).toContain('Author rules.');
      expect(prompt.system).not.toContain('Brand rules.');
    });

    it('uses rules only in simple mode (no source_rules)', () => {
      const tweet = makeTweet('1', 'test');
      const prompt = buildJudgePrompt(JUDGE_CONFIG, [tweet], 'ecosystem-core');
      expect(prompt.system).toBe(JUDGE_CONFIG.rules);
    });
  });

  describe('validateJudgeResult', () => {
    it('accepts valid result', () => {
      expect(validateJudgeResult(JUDGE_CONFIG, { alertLevel: 'orange', reasoning: 'Important' })).toBe(true);
      expect(validateJudgeResult(JUDGE_CONFIG, { alertLevel: 'none', reasoning: 'Spam' })).toBe(true);
    });

    it('rejects invalid alertLevel', () => {
      expect(validateJudgeResult(JUDGE_CONFIG, { alertLevel: 'purple', reasoning: 'test' })).toBe(false);
    });

    it('accepts reasoning longer than schema max_length', () => {
      expect(validateJudgeResult(JUDGE_CONFIG, { alertLevel: 'orange', reasoning: 'x'.repeat(201) })).toBe(true);
    });

    it('rejects missing fields', () => {
      expect(validateJudgeResult(JUDGE_CONFIG, { alertLevel: 'red' })).toBe(false);
      expect(validateJudgeResult(JUDGE_CONFIG, { reasoning: 'test' })).toBe(false);
      expect(validateJudgeResult(JUDGE_CONFIG, null)).toBe(false);
      expect(validateJudgeResult(JUDGE_CONFIG, undefined)).toBe(false);
    });

    it('rejects non-string reasoning', () => {
      expect(validateJudgeResult(JUDGE_CONFIG, { alertLevel: 'red', reasoning: 123 })).toBe(false);
    });
  });

  describe('judgeTweets', () => {
    it('calls LLM and parses single tweet response', async () => {
      const mockLlm = vi.fn().mockResolvedValue(
        '{"alertLevel": "orange", "reasoning": "Positive mention of Byreal"}'
      );
      const tweets = [makeTweet('1', 'Byreal is great')];
      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(mockLlm).toHaveBeenCalledTimes(1);
      expect(results.get('1')).toEqual({
        alertLevel: 'orange',
        reasoning: 'Positive mention of Byreal',
      });
    });

    it('calls LLM and parses batch response', async () => {
      const mockLlm = vi.fn().mockResolvedValue(
        JSON.stringify({
          results: [
            { tweetId: '1', alertLevel: 'orange', reasoning: 'Important' },
            { tweetId: '2', alertLevel: 'none', reasoning: 'Spam' },
          ]
        })
      );
      const tweets = [makeTweet('1', 'tweet 1'), makeTweet('2', 'tweet 2')];
      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(results.get('1')?.alertLevel).toBe('orange');
      expect(results.get('2')?.alertLevel).toBe('none');
    });

    it('accepts a top-level JSON array for batch responses', async () => {
      const mockLlm = vi.fn().mockResolvedValue(
        JSON.stringify([
          { tweetId: '1', alertLevel: 'orange', reasoning: 'Important' },
          { tweetId: '2', alertLevel: 'none', reasoning: 'Spam' },
        ])
      );
      const tweets = [makeTweet('1', 'tweet 1'), makeTweet('2', 'tweet 2')];
      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(results.get('1')?.alertLevel).toBe('orange');
      expect(results.get('2')?.alertLevel).toBe('none');
    });

    it('falls back to yellow on LLM error', async () => {
      const mockLlm = vi.fn().mockRejectedValue(new Error('API timeout'));
      const tweets = [makeTweet('1', 'test')];
      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(results.get('1')?.alertLevel).toBe('yellow');
      expect(results.get('1')?.reasoning).toContain('Judge error');
    });

    it('falls back to yellow on invalid JSON', async () => {
      const mockLlm = vi.fn().mockResolvedValue('not json at all');
      const tweets = [makeTweet('1', 'test')];
      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(results.get('1')?.alertLevel).toBe('yellow');
      expect(results.get('1')?.reasoning).toContain('fallback');
    });

    it('batches by JUDGE_BATCH_SIZE', async () => {
      const mockLlm = vi.fn().mockImplementation(async () => {
        return JSON.stringify({
          results: Array.from({ length: 5 }, (_, i) => ({
            tweetId: String(i), alertLevel: 'yellow', reasoning: 'test',
          }))
        });
      });

      // Create 7 tweets - should result in 2 LLM calls (5 + 2)
      const tweets = Array.from({ length: 7 }, (_, i) => makeTweet(String(i), `tweet ${i}`));
      await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(mockLlm).toHaveBeenCalledTimes(2);
    });

    it('logs batch result count mismatch and falls back missing items', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockLlm = vi.fn().mockResolvedValue(
        JSON.stringify({
          results: [{ tweetId: '1', alertLevel: 'orange', reasoning: 'Only one result returned' }],
        })
      );

      const tweets = [makeTweet('1', 'tweet 1'), makeTweet('2', 'tweet 2')];
      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);

      expect(results.get('1')?.alertLevel).toBe('orange');
      expect(results.get('2')?.reasoning).toBe('Judge parse error — fallback');
      expect(warnSpy).toHaveBeenCalledWith(
        '[judge] Batch result count mismatch',
        expect.objectContaining({ requested: 2, returned: 1 })
      );
    });

    it('opens the circuit breaker after repeated failures', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockLlm = vi.fn().mockRejectedValue(new Error('API timeout'));
      const tweets = [makeTweet('1', 'test')];

      for (let i = 0; i < 5; i += 1) {
        await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);
      }

      const results = await judgeTweets(JUDGE_CONFIG, tweets, mockLlm);
      expect(results.get('1')?.reasoning).toBe('Judge circuit open — fallback');
      expect(mockLlm).toHaveBeenCalledTimes(5);
      expect(warnSpy).toHaveBeenCalledWith(
        '[judge] Circuit breaker open, skipping LLM call',
        expect.objectContaining({ tweetIds: ['1'] })
      );
    });
  });
});
