import type { JudgeConfig, JudgeResult, RawTweet } from './types.js';
import { buildJsonExample, extractFirstJsonValue } from './output-schema.js';

/** 每批次最多发给 LLM 评判的推文数量，避免单次请求过长 */
const JUDGE_BATCH_SIZE = 5;
const JUDGE_CIRCUIT_BREAKER_THRESHOLD = 5;
const JUDGE_CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

type CircuitBreakerState = {
  consecutiveFailures: number;
  openUntil: number | null;
};

const judgeCircuitBreaker: CircuitBreakerState = {
  consecutiveFailures: 0,
  openUntil: null,
};

function isJudgeCircuitOpen(now = Date.now()): boolean {
  return judgeCircuitBreaker.openUntil !== null && judgeCircuitBreaker.openUntil > now;
}

function recordJudgeSuccess(): void {
  judgeCircuitBreaker.consecutiveFailures = 0;
  judgeCircuitBreaker.openUntil = null;
}

function recordJudgeFailure(context: { sourceName?: string; tweetIds: string[]; reason: string }): void {
  judgeCircuitBreaker.consecutiveFailures += 1;
  if (judgeCircuitBreaker.consecutiveFailures < JUDGE_CIRCUIT_BREAKER_THRESHOLD) {
    return;
  }

  judgeCircuitBreaker.openUntil = Date.now() + JUDGE_CIRCUIT_BREAKER_COOLDOWN_MS;
  console.warn('[judge] Circuit breaker opened', {
    sourceName: context.sourceName,
    tweetIds: context.tweetIds,
    reason: context.reason,
    consecutiveFailures: judgeCircuitBreaker.consecutiveFailures,
    cooldownMs: JUDGE_CIRCUIT_BREAKER_COOLDOWN_MS,
  });
}

function getJudgeCircuitFallback(tweetIds: string[]): Map<string, JudgeResult> {
  const results = new Map<string, JudgeResult>();
  for (const id of tweetIds) {
    results.set(id, { alertLevel: 'yellow', reasoning: 'Judge circuit open — fallback' });
  }
  return results;
}

/**
 * 构建发送给 LLM 的评判提示词（Prompt）。
 *
 * 将多条推文格式化为带编号的文本块，并在末尾附加 JSON 输出格式要求。
 * 单条推文时要求返回单对象，多条推文时要求返回数组。
 *
 * @param config - 评判配置，包含 rules（系统提示词）
 * @param tweets - 待评判的原始推文列表
 * @returns 包含 system 和 user 两段提示词的对象
 */
export function buildJudgePrompt(config: JudgeConfig, tweets: RawTweet[], sourceName?: string): { system: string; user: string } {
  const tweetBlock = tweets.map((t, i) => {
    // 优先展示作者粉丝数（比刚发布的推文互动数更有参考价值）
    const followers = t.metadata?.authorFollowers;
    const followersStr = typeof followers === 'number' && followers > 0
      ? ` | followers: ${followers >= 1000 ? `${(followers / 1000).toFixed(1)}K` : followers}`
      : '';
    const m = t.metrics;
    const metricsStr = m && (m.likes || m.retweets || m.views)
      ? ` | likes: ${m.likes ?? 0}, retweets: ${m.retweets ?? 0}, views: ${m.views ?? 0}`
      : '';
    const sourceStr = sourceName ? ` | source: ${sourceName}` : '';
    return `[Tweet ${i + 1}] id=${t.id} @${t.author}${followersStr}${metricsStr}${sourceStr}\n${t.content}`;
  }).join('\n\n---\n\n');

  // 要求 LLM 严格按照 JSON schema 输出，防止自由格式导致解析失败
  const singleResultSchema = buildJsonExample(config.output_schema);
  const batchItemSchema = JSON.stringify({ tweetId: '...', ...JSON.parse(singleResultSchema) });
  const schemaInstruction = `\n\nYou MUST respond with valid JSON. For a single tweet, return: ${singleResultSchema}\nFor multiple tweets, return: {"results": [${batchItemSchema}, ...]}`;

  const user = tweets.length === 1
    ? `Please judge this tweet:\n\n${tweetBlock}${schemaInstruction}`
    : `Please judge each of these ${tweets.length} tweets. Return a JSON object with a "results" array containing one result per tweet in order.\n\n${tweetBlock}${schemaInstruction}`;

  // 动态裁剪模式：拼装 rules + 当前 source 对应的 source_rules + author_rules
  // 简单模式（无 source_rules）：直接用 rules 原文
  const system = assembleSystemPrompt(config, sourceName);

  return { system, user };
}

/**
 * 根据 sourceName 动态拼装 system prompt。
 * - 有 source_rules：rules（前言）+ 匹配的 source_rules 段 + author_rules
 * - 无 source_rules：退化为 config.rules 全文
 */
function assembleSystemPrompt(config: JudgeConfig, sourceName?: string): string {
  if (!config.source_rules) return config.rules;

  const parts = [config.rules];

  if (sourceName && config.source_category_map) {
    const category = config.source_category_map[sourceName];
    if (category && config.source_rules[category]) {
      parts.push(config.source_rules[category]);
    }
  }

  if (config.author_rules) {
    parts.push(config.author_rules);
  }

  return parts.join('\n\n');
}

/**
 * 校验 LLM 返回的评判结果是否符合 JudgeResult 类型约束。
 *
 * 用于类型守卫（type guard），同时验证 alertLevel 必须是合法枚举值。
 *
 * @param result - 待校验的未知对象
 * @returns 若合法则返回 true，并将类型收窄为 JudgeResult
 */
export function validateJudgeResult(config: JudgeConfig, result: unknown): result is JudgeResult {
  if (!result || typeof result !== 'object') {
    return false;
  }

  const record = result as Record<string, unknown>;
  const alertLevel = record.alertLevel;
  const reasoning = record.reasoning;
  const allowedAlertLevels = config.output_schema.alertLevel.values;

  return (
    typeof alertLevel === 'string'
    && allowedAlertLevels.includes(alertLevel)
    && typeof reasoning === 'string'
  );
}

/**
 * LLM 调用函数的类型签名，采用依赖注入方式以便单元测试时替换为 mock。
 *
 * @param system - 系统提示词
 * @param user - 用户消息
 * @returns LLM 原始响应文本
 */
export type LlmCallFn = (system: string, user: string) => Promise<string>;

/**
 * 解析 LLM 返回的原始文本，提取每条推文的评判结果。
 *
 * 支持两种响应格式：
 * - 批量格式：`{"results": [...]}`
 * - 单条格式：`{"alertLevel": ..., "reasoning": ...}`
 *
 * 解析失败时对所有推文降级为 yellow（保守策略，不丢弃）。
 *
 * @param raw - LLM 返回的原始字符串
 * @param tweetIds - 本批次推文 ID 列表（顺序需与 prompt 中一致）
 * @returns 以 tweetId 为 key 的评判结果 Map
 */
function parseJudgeResponse(config: JudgeConfig, raw: string, tweetIds: string[]): Map<string, JudgeResult> {
  const results = new Map<string, JudgeResult>();

  try {
    const candidate = extractFirstJsonValue(raw);
    if (!candidate) throw new Error('No JSON found');

    const parsed = JSON.parse(candidate) as Record<string, unknown> | Array<Record<string, unknown>>;
    const batchResults = Array.isArray(parsed)
      ? parsed
      : (parsed.results && Array.isArray(parsed.results) ? parsed.results as Array<Record<string, unknown>> : null);

    if (batchResults) {
      if (batchResults.length !== tweetIds.length) {
        console.warn('[judge] Batch result count mismatch', {
          requested: tweetIds.length,
          returned: batchResults.length,
          tweetIds,
          raw: raw.slice(0, 800),
        });
      }

      // 批量响应：按下标与 tweetIds 对应
      for (let i = 0; i < tweetIds.length; i++) {
        const item = batchResults[i];
        if (item && validateJudgeResult(config, item)) {
          results.set(tweetIds[i], item as unknown as JudgeResult);
        } else {
          // 单条解析失败时降级为 yellow，不影响其他条目
          console.warn('[judge] Invalid batch item, using fallback', {
            tweetId: tweetIds[i],
            item,
          });
          results.set(tweetIds[i], { alertLevel: 'yellow', reasoning: 'Judge parse error — fallback' });
        }
      }
    } else if (!Array.isArray(parsed) && tweetIds.length === 1 && validateJudgeResult(config, parsed)) {
      // 单条响应：直接映射
      results.set(tweetIds[0], parsed as unknown as JudgeResult);
    } else {
      throw new Error('Unexpected response format');
    }
  } catch (err) {
    console.warn('[judge] Failed to parse LLM response, using fallback', {
      error: err instanceof Error ? err.message : String(err),
      raw: raw.slice(0, 800),
    });
    // 整体解析失败：所有推文标记为 yellow，避免遗漏处理
    for (const id of tweetIds) {
      results.set(id, { alertLevel: 'yellow', reasoning: 'Judge parse error — fallback' });
    }
  }

  return results;
}

/**
 * 批量评判推文，将推文按 JUDGE_BATCH_SIZE 分批发给 LLM 处理。
 *
 * 每批独立调用 LLM，批次内部错误不影响其他批次。
 * 调用失败的批次内所有推文降级为 yellow 并携带错误信息。
 *
 * @param config - 评判配置（含规则提示词）
 * @param tweets - 全量待评判推文
 * @param llmCall - LLM 调用函数（依赖注入）
 * @returns 以 tweetId 为 key 的评判结果 Map，覆盖所有输入推文
 */
export async function judgeTweets(
  config: JudgeConfig,
  tweets: RawTweet[],
  llmCall: LlmCallFn,
  sourceName?: string,
): Promise<Map<string, JudgeResult>> {
  const allResults = new Map<string, JudgeResult>();

  // 按固定批次大小切片，逐批提交给 LLM
  for (let i = 0; i < tweets.length; i += JUDGE_BATCH_SIZE) {
    const batch = tweets.slice(i, i + JUDGE_BATCH_SIZE);
    const prompt = buildJudgePrompt(config, batch, sourceName);
    const tweetIds = batch.map(t => t.id);

    if (isJudgeCircuitOpen()) {
      console.warn('[judge] Circuit breaker open, skipping LLM call', {
        sourceName,
        tweetIds,
        openUntil: judgeCircuitBreaker.openUntil,
      });
      const fallbackResults = getJudgeCircuitFallback(tweetIds);
      for (const [id, result] of fallbackResults) {
        allResults.set(id, result);
      }
      continue;
    }

    try {
      const raw = await llmCall(prompt.system, prompt.user);
      const batchResults = parseJudgeResponse(config, raw, tweetIds);
      const hadFallback = tweetIds.some((id) => batchResults.get(id)?.reasoning === 'Judge parse error — fallback');
      if (hadFallback) {
        recordJudgeFailure({ sourceName, tweetIds, reason: 'parse-fallback' });
      } else {
        recordJudgeSuccess();
      }
      // 将本批结果合并到总结果 Map 中
      for (const [id, result] of batchResults) {
        allResults.set(id, result);
      }
    } catch (err) {
      recordJudgeFailure({
        sourceName,
        tweetIds,
        reason: err instanceof Error ? err.message : String(err),
      });
      // 整批 LLM 调用失败：为该批所有推文设置错误降级结果
      for (const id of tweetIds) {
        allResults.set(id, { alertLevel: 'yellow', reasoning: `Judge error: ${(err as Error).message}` });
      }
    }
  }

  return allResults;
}

export { JUDGE_BATCH_SIZE };
export function resetJudgeCircuitBreaker(): void {
  judgeCircuitBreaker.consecutiveFailures = 0;
  judgeCircuitBreaker.openUntil = null;
}
