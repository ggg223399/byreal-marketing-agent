import { describe, it, expect, vi } from 'vitest';
import { applyPreFilter, resolveSourcePrompt, splitHandlesBatch, deduplicateTweets, executeSource, MAX_HANDLES_PER_CALL } from '../../engine/searcher.js';
import type { RawTweet, SourceConfig } from '../../engine/types.js';

function makeTweet(id: string, content: string): RawTweet {
  return { id, author: `@user${id}`, content, url: `https://x.com/${id}`, created_at: Date.now() };
}

describe('searcher', () => {
  describe('applyPreFilter', () => {
    it('filters by exclude_patterns', () => {
      const tweets = [
        makeTweet('1', 'Giveaway! Tag 3 friends and win'),
        makeTweet('2', 'Byreal CLMM is impressive'),
      ];
      const filtered = applyPreFilter(tweets, {
        exclude_patterns: ['(?i)giveaway|airdrop'],
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('2');
    });

    it('filters by min_length', () => {
      const tweets = [
        makeTweet('1', 'hi'),
        makeTweet('2', 'This is a longer tweet about Byreal and DeFi'),
      ];
      const filtered = applyPreFilter(tweets, { min_length: 10 });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('2');
    });

    it('applies both filters together', () => {
      const tweets = [
        makeTweet('1', 'Giveaway! Tag friends'),
        makeTweet('2', 'hi'),
        makeTweet('3', 'Byreal CLMM deep liquidity analysis'),
      ];
      const filtered = applyPreFilter(tweets, {
        exclude_patterns: ['(?i)giveaway'],
        min_length: 10,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('3');
    });

    it('returns all when no filter', () => {
      const tweets = [makeTweet('1', 'hello')];
      expect(applyPreFilter(tweets, undefined)).toHaveLength(1);
    });

    it('returns all when filter has no rules', () => {
      const tweets = [makeTweet('1', 'hello')];
      expect(applyPreFilter(tweets, {})).toHaveLength(1);
    });
  });

  describe('resolveSourcePrompt', () => {
    it('replaces template variables', () => {
      const result = resolveSourcePrompt(
        'Search for {{active_keywords}} discussion',
        { active_keywords: 'RWA, CLMM' }
      );
      expect(result).toBe('Search for RWA, CLMM discussion');
    });

    it('preserves unmatched vars', () => {
      expect(resolveSourcePrompt('{{missing}} test', {})).toBe('{{missing}} test');
    });

    it('handles multiple vars', () => {
      const result = resolveSourcePrompt('{{a}} and {{b}}', { a: 'X', b: 'Y' });
      expect(result).toBe('X and Y');
    });

    it('normalizes whitespace in template vars', () => {
      const result = resolveSourcePrompt('Search for {{keywords}} discussion', {
        keywords: '  RWA,\n\n   CLMM   ',
      });
      expect(result).toBe('Search for RWA, CLMM discussion');
    });

    it('keeps prompt unchanged if no template vars', () => {
      expect(resolveSourcePrompt('Search for Byreal', {})).toBe('Search for Byreal');
    });
  });

  describe('splitHandlesBatch', () => {
    it('splits handles into batches of MAX_HANDLES_PER_CALL', () => {
      const handles = Array.from({ length: 25 }, (_, i) => `user${i}`);
      const batches = splitHandlesBatch(handles);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(MAX_HANDLES_PER_CALL);
      expect(batches[1]).toHaveLength(MAX_HANDLES_PER_CALL);
      expect(batches[2]).toHaveLength(5);
    });

    it('handles empty array', () => {
      expect(splitHandlesBatch([])).toEqual([]);
    });

    it('handles fewer than batch size', () => {
      const batches = splitHandlesBatch(['a', 'b']);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual(['a', 'b']);
    });
  });

  describe('deduplicateTweets', () => {
    it('removes duplicate tweet IDs', () => {
      const tweets = [
        makeTweet('1', 'first'),
        makeTweet('1', 'duplicate'),
        makeTweet('2', 'second'),
      ];
      const deduped = deduplicateTweets(tweets);
      expect(deduped).toHaveLength(2);
      expect(deduped[0].content).toBe('first'); // keeps first occurrence
    });
  });

  describe('executeSource', () => {
    it('searches and applies pre_filter', async () => {
      const source: SourceConfig = {
        name: 'test',
        schedule: '*/15 * * * *',
        prompt: 'Search for Byreal',
        pre_filter: { exclude_patterns: ['(?i)spam'] },
      };

      const mockSearch = vi.fn().mockResolvedValue([
        makeTweet('1', 'Byreal is great'),
        makeTweet('2', 'SPAM buy now'),
      ]);

      const result = await executeSource(source, mockSearch, {});
      expect(result.tweets).toHaveLength(1);
      expect(result.tweets[0].id).toBe('1');
      expect(result.filteredCount).toBe(1);
      expect(result.totalSearched).toBe(2);
    });

    it('deduplicates tweets', async () => {
      const source: SourceConfig = {
        name: 'test',
        schedule: '*/15 * * * *',
        prompt: 'Search',
      };

      const mockSearch = vi.fn().mockResolvedValue([
        makeTweet('1', 'tweet'),
        makeTweet('1', 'same tweet'),
      ]);

      const result = await executeSource(source, mockSearch, {});
      expect(result.tweets).toHaveLength(1);
    });

    it('resolves template vars in prompt', async () => {
      const source: SourceConfig = {
        name: 'test',
        schedule: '*/15 * * * *',
        prompt: 'Search for {{keywords}}',
      };

      const mockSearch = vi.fn().mockResolvedValue([]);
      await executeSource(source, mockSearch, { keywords: 'RWA, CLMM' });

      expect(mockSearch).toHaveBeenCalledWith('Search for RWA, CLMM');
    });
  });
});
