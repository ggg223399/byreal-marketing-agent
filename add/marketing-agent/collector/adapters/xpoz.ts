import type { CollectorConfig, DataSourceAdapter, RawTweet } from '../../types/index.js';

/**
 * XpozAdapter — Xpoz 平台数据源适配器（占位实现）
 *
 * 目前尚未实现，调用 fetchTweets 会直接抛出错误。
 * 待 Xpoz API 接入后在此补充具体实现。
 */
export class XpozAdapter implements DataSourceAdapter {
  name = 'xpoz';

  /**
   * 获取 tweet 列表（暂未实现）
   * @throws Error 始终抛出未实现错误
   */
  async fetchTweets(_config: CollectorConfig): Promise<RawTweet[]> {
    throw new Error('Xpoz adapter is not implemented yet');
  }
}
