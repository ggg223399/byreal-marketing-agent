import type { SourceConfig, PreFilter, RawTweet } from './types.js';

/** 每次搜索 API 调用最多传入的 handle 数量上限，防止请求体过大 */
const MAX_HANDLES_PER_CALL = 10;

/**
 * 对推文列表应用预过滤规则，过滤掉不符合条件的推文。
 *
 * 支持的过滤维度：
 * - `exclude_patterns`：正则表达式列表，匹配到任意一条则排除该推文。
 *   支持 PCRE 风格的内联标志（如 `(?i)` 转为 JS 的 `i` flag）。
 * - `min_length`：推文内容最小字符数，低于阈值的推文将被过滤。
 *
 * @param tweets 原始推文列表
 * @param filter 预过滤配置（可选，若为 undefined 则直接返回原列表）
 * @returns 过滤后的推文列表
 */
export function applyPreFilter(tweets: RawTweet[], filter: PreFilter | undefined): RawTweet[] {
  if (!filter) return tweets;

  let result = tweets;

  if (filter.exclude_patterns) {
    // 将配置中的字符串模式编译为 RegExp，并处理 PCRE 内联标志
    const regexps = filter.exclude_patterns.map(p => {
      // 检测 (?flags) 前缀，例如 (?i) 表示大小写不敏感，转为 JS RegExp flags 参数
      const match = p.match(/^\(\?([imsu]+)\)(.*)/s);
      if (match) {
        return new RegExp(match[2], match[1]);
      }
      return new RegExp(p);
    });
    // 任意一条排除模式匹配到内容，则过滤掉该推文
    result = result.filter(t => !regexps.some(r => r.test(t.content)));
  }

  if (filter.min_length) {
    const min = filter.min_length;
    // 过滤掉内容长度不足的推文（过短通常是无实质内容的水帖）
    result = result.filter(t => t.content.length >= min);
  }

  return result;
}

/**
 * 将 source prompt 模板中的 `{{key}}` 占位符替换为实际变量值。
 * 若变量表中不存在对应 key，则保留原始占位符不变。
 * @param prompt source 配置中的原始 prompt 模板字符串
 * @param vars   键值对变量表
 * @returns 替换后的 prompt 字符串
 */
export function resolveSourcePrompt(
  prompt: string,
  vars: Record<string, string>
): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (typeof value !== 'string') {
      return `{{${key}}}`;
    }

    // Keep YAML-driven template vars stable inside prompts: trim and collapse whitespace
    // so one variable cannot accidentally reshape the prompt structure.
    return value.trim().replace(/\s+/g, ' ');
  });
}

/**
 * 将 handle 列表按 `MAX_HANDLES_PER_CALL` 分批切割，
 * 避免单次 API 请求携带过多 handle 导致请求失败。
 * @param handles 完整的 handle 字符串数组
 * @returns 二维数组，每个子数组最多包含 MAX_HANDLES_PER_CALL 个元素
 */
export function splitHandlesBatch(handles: string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < handles.length; i += MAX_HANDLES_PER_CALL) {
    batches.push(handles.slice(i, i + MAX_HANDLES_PER_CALL));
  }
  return batches;
}

/**
 * 对推文列表按 tweet id 去重，保留首次出现的推文。
 * 多批次搜索结果合并时可能产生重复推文，通过此函数去除。
 * @param tweets 可能包含重复项的推文列表
 * @returns 去重后的推文列表
 */
export function deduplicateTweets(tweets: RawTweet[]): RawTweet[] {
  const seen = new Set<string>();
  return tweets.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/**
 * 搜索函数的类型定义，用于依赖注入。
 * @param prompt  搜索提示词
 * @param handles 可选的账号 handle 列表（用于账号维度的过滤搜索）
 * @returns 原始推文数组的 Promise
 */
export type SearchFn = (prompt: string, handles?: string[]) => Promise<RawTweet[]>;

/**
 * `executeSource` 的返回结果，包含推文列表和统计信息。
 * - `tweets`        经去重和预过滤后的推文列表
 * - `filteredCount` 被预过滤器过滤掉的推文数量
 * - `totalSearched` 去重后的总推文数（过滤前）
 */
export interface SearchResult {
  tweets: RawTweet[];
  filteredCount: number;
  totalSearched: number;
}

/**
 * 执行单个 source 的搜索流程：解析 prompt → 调用 searchFn → 去重 → 预过滤。
 *
 * 注意：若 source 配置了 accounts 列表，调用方应通过 searchFn 或外部批处理
 * 来传入 handles，本函数不负责拆分批次（见 `splitHandlesBatch`）。
 *
 * @param source    source 配置对象
 * @param searchFn  实际执行搜索的函数（依赖注入）
 * @param vars      prompt 模板变量表
 * @returns 包含过滤后推文及统计信息的 SearchResult
 */
export async function executeSource(
  source: SourceConfig,
  searchFn: SearchFn,
  vars: Record<string, string>,
): Promise<SearchResult> {
  const prompt = resolveSourcePrompt(source.prompt, vars);

  let allTweets: RawTweet[] = [];

  // searchFn 负责实际 API 调用。若 source 有 accounts 配置，
  // 调用方需通过 searchFn 或外部批处理传入 handles。
  allTweets = await searchFn(prompt);

  // 按 tweet ID 去重，防止同一条推文被多次计入
  allTweets = deduplicateTweets(allTweets);
  const totalSearched = allTweets.length;

  // 应用预过滤规则，过滤噪声推文
  const filtered = applyPreFilter(allTweets, source.pre_filter);

  return {
    tweets: filtered,
    filteredCount: totalSearched - filtered.length,
    totalSearched,
  };
}

export { MAX_HANDLES_PER_CALL };
