import type { CollectorConfig, DataSourceAdapter, RawTweet } from '../../types/index.js';

/**
 * MockAdapter — 本地测试用模拟数据适配器
 *
 * 不发起任何网络请求，直接返回一组硬编码的假 tweet，
 * 用于在没有真实 API Key 的环境下验证流水线逻辑。
 */
export class MockAdapter implements DataSourceAdapter {
  name = 'mock';

  /**
   * 返回 5 条模拟 tweet，时间戳以当前时间为基准向前偏移。
   * @param _config 采集器配置（此适配器不使用）
   */
  async fetchTweets(_config: CollectorConfig): Promise<RawTweet[]> {
    const now = Math.floor(Date.now() / 1000);

    return [
      {
        id: 'mock_1',
        author: '@solana',
        content: 'Byreal team is shipping meaningful DeFi UX improvements this week.',
        url: 'https://x.com/solana/status/mock_1',
        created_at: now - 60,   // 1 分钟前
      },
      {
        id: 'mock_2',
        author: '@aave',
        content: 'Watching Byreal liquidity flows, interesting execution quality so far.',
        url: 'https://x.com/aave/status/mock_2',
        created_at: now - 120,  // 2 分钟前
      },
      {
        id: 'mock_3',
        author: '@partner_account',
        content: 'Great to see partners experimenting with new yield strategies.',
        url: 'https://x.com/partner_account/status/mock_3',
        created_at: now - 180,  // 3 分钟前
      },
      {
        id: 'mock_4',
        author: '@random_user',
        content: 'gm',
        url: 'https://x.com/random_user/status/mock_4',
        created_at: now - 240,  // 4 分钟前
      },
      {
        id: 'mock_5',
        author: '@solana',
        content: 'Byreal could be a strong partner for cross-protocol liquidity alignment.',
        url: 'https://x.com/solana/status/mock_5',
        created_at: now - 300,  // 5 分钟前
      },
    ];
  }
}
