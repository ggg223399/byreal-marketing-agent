import { describe, expect, it } from 'vitest';
import { filterTweetsByCreatedAt } from '../../engine/index.js';
import type { RawTweet } from '../../engine/types.js';

function makeTweet(id: string, createdAt: number): RawTweet {
  return {
    id,
    author: `@user${id}`,
    content: `tweet ${id}`,
    url: `https://x.com/user/status/${id}`,
    created_at: createdAt,
  };
}

describe('engine search freshness guard', () => {
  it('drops tweets older than the cutoff timestamp', () => {
    const tweets = [
      makeTweet('old', 1749961606),
      makeTweet('edge', 1773187801),
      makeTweet('new', 1773187802),
    ];

    expect(filterTweetsByCreatedAt(tweets, 1773187801).map((tweet) => tweet.id)).toEqual(['edge', 'new']);
  });

  it('drops tweets with invalid created_at values', () => {
    const tweets = [
      makeTweet('valid', 1773187801),
      { ...makeTweet('invalid', Number.NaN), created_at: Number.NaN },
    ];

    expect(filterTweetsByCreatedAt(tweets, 1773187800).map((tweet) => tweet.id)).toEqual(['valid']);
  });
});
