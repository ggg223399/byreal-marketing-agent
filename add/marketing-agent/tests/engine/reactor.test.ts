import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  assembleReactorSystemPrompt,
  buildReactorPrompt,
  validateReactorResult,
  reactToTweet,
  resetReactorCircuitBreaker,
} from '../../engine/reactor.js';
import type { ReactorConfig, RawTweet, JudgeResult } from '../../engine/types.js';

const REACTOR_CONFIG: ReactorConfig = {
  brand_context_ref: 'brand.md',
  rules: 'You are a social media strategist. Decide how to react.',
  source_category_map: {
    'solana-kols': 'kol',
    crisis: 'crisis',
  },
  source_rules: {
    kol: 'KOL-specific guidance.',
    crisis: 'Crisis-specific guidance.',
  },
  priority_rules: 'Priority guidance.',
  anti_patterns: 'Anti-pattern guidance.',
  output_schema: {
    suggestedAction: { type: 'enum', values: ['reply_supportive', 'qrt_positioning', 'collab_opportunity', 'like_only', 'explore_signal', 'escalate_internal', 'none'], description: 'Action' },
    replyAngle: { type: 'string', max_length: 300, description: 'Reply angle' },
    tones: { type: 'array', min_items: 1, max_items: 3, item_fields: ['id', 'label', 'description'], description: 'Tone options' },
  },
};

const BRAND_CONTEXT = 'Byreal is a hybrid DEX on Solana.';

function makeTweet(content: string): RawTweet {
  return { id: '1', author: '@jup', content, url: 'https://x.com/1', created_at: Date.now() };
}

const JUDGE_RESULT: JudgeResult = { alertLevel: 'orange', reasoning: 'KOL mention' };

describe('reactor', () => {
  beforeEach(() => {
    resetReactorCircuitBreaker();
    vi.restoreAllMocks();
  });

  describe('buildReactorPrompt', () => {
    it('includes rules, brand context, tweet, and judge result', () => {
      const prompt = buildReactorPrompt(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('Integrating with Byreal!'), JUDGE_RESULT);
      expect(prompt.system).toContain('social media strategist');
      expect(prompt.system).toContain('hybrid DEX');
      expect(prompt.user).toContain('Integrating with Byreal');
      expect(prompt.user).toContain('orange');
      expect(prompt.user).toContain('KOL mention');
    });

    it('includes metrics and views when available', () => {
      const tweet: RawTweet = { ...makeTweet('test'), metrics: { likes: 500, retweets: 100, views: 9000 } };
      const prompt = buildReactorPrompt(REACTOR_CONFIG, BRAND_CONTEXT, tweet, JUDGE_RESULT);
      expect(prompt.user).toContain('likes=500');
      expect(prompt.user).toContain('views=9000');
    });

    it('includes follower count when available', () => {
      const tweet: RawTweet = { ...makeTweet('test'), metadata: { authorFollowers: 85000 } };
      const prompt = buildReactorPrompt(REACTOR_CONFIG, BRAND_CONTEXT, tweet, JUDGE_RESULT);
      expect(prompt.user).toContain('followers=85.0K');
    });

    it('includes source name when provided', () => {
      const prompt = buildReactorPrompt(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, 'solana-kols');
      expect(prompt.user).toContain('Source: solana-kols');
    });

    it('omits source line when not provided', () => {
      const prompt = buildReactorPrompt(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT);
      expect(prompt.user).not.toContain('Source:');
    });

    it('assembles only matching source_rules plus shared reactor sections', () => {
      const system = assembleReactorSystemPrompt(
        REACTOR_CONFIG,
        BRAND_CONTEXT,
        'solana-kols',
      );

      expect(system).toContain('social media strategist');
      expect(system).toContain('KOL-specific guidance.');
      expect(system).not.toContain('Crisis-specific guidance.');
      expect(system).toContain('Priority guidance.');
      expect(system).toContain('Anti-pattern guidance.');
      expect(system).toContain('Brand Context:');
      expect(system).toContain('hybrid DEX');
    });

    it('falls back to base rules when no source mapping exists', () => {
      const system = assembleReactorSystemPrompt(
        REACTOR_CONFIG,
        BRAND_CONTEXT,
        'unknown-source',
      );

      expect(system).toContain('social media strategist');
      expect(system).not.toContain('KOL-specific guidance.');
      expect(system).not.toContain('Crisis-specific guidance.');
      expect(system).toContain('Priority guidance.');
    });
  });

  describe('validateReactorResult', () => {
    it('accepts valid result', () => {
      expect(validateReactorResult(REACTOR_CONFIG, {
        suggestedAction: 'reply_supportive',
        tones: [{ id: 'casual', label: 'Casual', description: 'Friendly tone' }],
        replyAngle: 'be friendly',
      })).toBe(true);
    });

    it('rejects invalid action', () => {
      expect(validateReactorResult(REACTOR_CONFIG, {
        suggestedAction: 'invalid_action',
        tones: [{ id: 'casual', label: 'Casual', description: 'Friendly tone' }],
        replyAngle: 'test',
      })).toBe(false);
    });

    it('rejects invalid tones (not array)', () => {
      expect(validateReactorResult(REACTOR_CONFIG, {
        suggestedAction: 'reply_supportive',
        tones: 'casual',
        replyAngle: 'test',
      })).toBe(false);
    });

    it('rejects missing replyAngle', () => {
      expect(validateReactorResult(REACTOR_CONFIG, {
        suggestedAction: 'reply_supportive',
        tones: [{ id: 'casual', label: 'Casual', description: 'Friendly tone' }],
      })).toBe(false);
    });

    it('rejects replyAngle longer than schema max_length', () => {
      expect(validateReactorResult(REACTOR_CONFIG, {
        suggestedAction: 'reply_supportive',
        tones: [{ id: 'casual', label: 'Casual', description: 'Friendly tone' }],
        replyAngle: 'x'.repeat(301),
      })).toBe(false);
    });

    it('rejects null/undefined', () => {
      expect(validateReactorResult(REACTOR_CONFIG, null)).toBe(false);
      expect(validateReactorResult(REACTOR_CONFIG, undefined)).toBe(false);
    });
  });

  describe('reactToTweet', () => {
    it('calls LLM and parses valid response', async () => {
      const mockLlm = vi.fn().mockResolvedValue(
        JSON.stringify({
          suggestedAction: 'reply_supportive',
          tones: [
            { id: 'meme', label: 'Meme', description: 'CT degen style' },
            { id: 'casual', label: 'Casual', description: 'Friendly chat' },
          ],
          replyAngle: 'Use degen language, mention Real Farmer for passive LP',
        })
      );

      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('gm degens'), JUDGE_RESULT, mockLlm);
      expect(result.suggestedAction).toBe('reply_supportive');
      expect(result.tones[0].id).toBe('meme');
      expect(result.tones).toHaveLength(2);
      expect(result.replyAngle).toContain('degen');
      expect(mockLlm).toHaveBeenCalledTimes(1);
    });

    it('falls back to like_only on invalid response', async () => {
      const mockLlm = vi
        .fn()
        .mockResolvedValueOnce('not valid json')
        .mockResolvedValueOnce(
          JSON.stringify({
            suggestedAction: 'like_only',
            tones: [
              {
                id: 'casual',
                label: 'Casual',
                description: 'Friendly tone',
              },
            ],
            replyAngle: 'Recovered after format retry',
          })
        );
      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);
      expect(result.suggestedAction).toBe('like_only');
      expect(result.tones[0].id).toBe('casual');
      expect(result.replyAngle).toContain('Recovered after format retry');
      expect(mockLlm).toHaveBeenCalledTimes(2);
    });

    it('falls back to like_only on LLM error', async () => {
      const mockLlm = vi.fn().mockRejectedValue(new Error('API timeout'));
      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);
      expect(result.suggestedAction).toBe('like_only');
      expect(result.tones[0].id).toBe('casual');
      expect(result.replyAngle).toContain('Reactor error');
    });

    it('handles JSON embedded in text', async () => {
      const mockLlm = vi.fn().mockResolvedValue(
        'Here is my analysis:\n```json\n{"suggestedAction": "qrt_positioning", "tones": [{"id": "technical", "label": "Technical", "description": "Data-driven approach"}], "replyAngle": "Compare RFQ depth"}\n```'
      );
      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);
      expect(result.suggestedAction).toBe('qrt_positioning');
      expect(result.tones[0].id).toBe('technical');
    });

    it('handles a JSON array before surrounding object text elsewhere', async () => {
      const mockLlm = vi.fn().mockResolvedValue(
        'Tones considered: [{"id":"technical","label":"Technical","description":"Data-driven"}]\nFinal answer:\n{"suggestedAction":"like_only","tones":[{"id":"casual","label":"Casual","description":"Friendly"}],"replyAngle":"Acknowledge briefly"}'
      );
      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);
      expect(result.suggestedAction).toBe('like_only');
      expect(result.replyAngle).toContain('Acknowledge briefly');
    });

    it('retries when JSON exists but does not match schema', async () => {
      const mockLlm = vi
        .fn()
        .mockResolvedValueOnce(
          '```json\n{"suggestedAction":"like_only","replyAngle":"Too sparse","tones":[]}\n```\n\nRationale: ...'
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            suggestedAction: 'like_only',
            tones: [
              {
                id: 'official',
                label: 'Official',
                description: 'Measured and concise',
              },
            ],
            replyAngle: 'Acknowledge briefly without forcing a reply.',
          })
        );

      const result = await reactToTweet(
        REACTOR_CONFIG,
        BRAND_CONTEXT,
        makeTweet('test'),
        JUDGE_RESULT,
        mockLlm,
        'crisis'
      );

      expect(result.suggestedAction).toBe('like_only');
      expect(result.tones[0].id).toBe('official');
      expect(result.replyAngle).toContain('Acknowledge briefly');
      expect(mockLlm).toHaveBeenCalledTimes(2);
    });

    it('logs schema mismatch details on format retry failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockLlm = vi
        .fn()
        .mockResolvedValueOnce(
          '{"suggestedAction":"like_only","tones":[],"replyAngle":"Too sparse"}'
        )
        .mockResolvedValueOnce('still not json');

      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);

      expect(result.suggestedAction).toBe('like_only');
      expect(warnSpy).toHaveBeenCalledWith(
        '[reactor] Failed to parse LLM response, attempting format retry',
        expect.objectContaining({
          reason: expect.stringContaining('Schema mismatch: tones: expected 1-3 items'),
        })
      );
    });

    it('opens the circuit breaker after repeated failures', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockLlm = vi.fn().mockRejectedValue(new Error('API timeout'));

      for (let i = 0; i < 5; i += 1) {
        await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);
      }

      const result = await reactToTweet(REACTOR_CONFIG, BRAND_CONTEXT, makeTweet('test'), JUDGE_RESULT, mockLlm);
      expect(result.replyAngle).toBe('Reactor circuit open — fallback to like');
      expect(mockLlm).toHaveBeenCalledTimes(5);
      expect(warnSpy).toHaveBeenCalledWith(
        '[reactor] Circuit breaker open, skipping LLM call',
        expect.objectContaining({ tweetId: '1' })
      );
    });
  });
});
