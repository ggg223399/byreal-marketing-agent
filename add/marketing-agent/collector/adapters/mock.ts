import type { CollectorConfig, DataSourceAdapter, RawTweet } from '../../types/index.js';

export class MockAdapter implements DataSourceAdapter {
  name = 'mock';

  async fetchTweets(_config: CollectorConfig): Promise<RawTweet[]> {
    const now = Math.floor(Date.now() / 1000);

    return [
      {
        id: 'mock_1',
        author: '@solana',
        content: 'Byreal team is shipping meaningful DeFi UX improvements this week.',
        url: 'https://x.com/solana/status/mock_1',
        created_at: now - 60,
      },
      {
        id: 'mock_2',
        author: '@aave',
        content: 'Watching Byreal liquidity flows, interesting execution quality so far.',
        url: 'https://x.com/aave/status/mock_2',
        created_at: now - 120,
      },
      {
        id: 'mock_3',
        author: '@partner_account',
        content: 'Great to see partners experimenting with new yield strategies.',
        url: 'https://x.com/partner_account/status/mock_3',
        created_at: now - 180,
      },
      {
        id: 'mock_4',
        author: '@random_user',
        content: 'gm',
        url: 'https://x.com/random_user/status/mock_4',
        created_at: now - 240,
      },
      {
        id: 'mock_5',
        author: '@solana',
        content: 'Byreal could be a strong partner for cross-protocol liquidity alignment.',
        url: 'https://x.com/solana/status/mock_5',
        created_at: now - 300,
      },
    ];
  }
}
