import type { CollectorConfig, DataSourceAdapter, RawTweet } from '../../types/index.js';

export class XpozAdapter implements DataSourceAdapter {
  name = 'xpoz';

  async fetchTweets(_config: CollectorConfig): Promise<RawTweet[]> {
    throw new Error('Xpoz adapter is not implemented yet');
  }
}
