import type { ReactorConfig, ReactorResult, RawTweet, JudgeResult } from './types.js';
import {
  buildJsonExample,
  explainObjectSchemaMismatch,
  extractJsonObjects,
  validateObjectAgainstSchema,
} from './output-schema.js';

const REACTOR_CIRCUIT_BREAKER_THRESHOLD = 5;
const REACTOR_CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

type CircuitBreakerState = {
  consecutiveFailures: number;
  openUntil: number | null;
};

const reactorCircuitBreaker: CircuitBreakerState = {
  consecutiveFailures: 0,
  openUntil: null,
};

function isReactorCircuitOpen(now = Date.now()): boolean {
  return reactorCircuitBreaker.openUntil !== null && reactorCircuitBreaker.openUntil > now;
}

function recordReactorSuccess(): void {
  reactorCircuitBreaker.consecutiveFailures = 0;
  reactorCircuitBreaker.openUntil = null;
}

function recordReactorFailure(context: { tweetId: string; sourceName?: string; reason: string }): void {
  reactorCircuitBreaker.consecutiveFailures += 1;
  if (reactorCircuitBreaker.consecutiveFailures < REACTOR_CIRCUIT_BREAKER_THRESHOLD) {
    return;
  }

  reactorCircuitBreaker.openUntil = Date.now() + REACTOR_CIRCUIT_BREAKER_COOLDOWN_MS;
  console.warn('[reactor] Circuit breaker opened', {
    tweetId: context.tweetId,
    sourceName: context.sourceName,
    reason: context.reason,
    consecutiveFailures: reactorCircuitBreaker.consecutiveFailures,
    cooldownMs: REACTOR_CIRCUIT_BREAKER_COOLDOWN_MS,
  });
}

/**
 * 构建发送给 LLM 的回应策略提示词（Prompt）。
 *
 * 将品牌上下文、推文内容、作者信息、互动数据以及 Judge 评判结果组合为
 * 完整的 user 消息，并要求 LLM 以 JSON 格式返回建议动作、语气和回复角度。
 *
 * @param config - Reactor 配置，包含行动规则（rules）
 * @param brandContext - 品牌背景信息（注入 system prompt）
 * @param tweet - 待处理的原始推文
 * @param judgeResult - Judge 对该推文的评判结果（alertLevel + reasoning）
 * @returns 包含 system 和 user 两段提示词的对象
 */
export function buildReactorPrompt(
  config: ReactorConfig,
  brandContext: string,
  tweet: RawTweet,
  judgeResult: JudgeResult,
  sourceName?: string,
): { system: string; user: string } {
  const system = assembleReactorSystemPrompt(config, brandContext, sourceName);

  // 作者粉丝数（与 judge 保持一致的格式）
  const followers = tweet.metadata?.authorFollowers;
  const followersStr = typeof followers === 'number' && followers > 0
    ? `, followers=${followers >= 1000 ? `${(followers / 1000).toFixed(1)}K` : followers}`
    : '';

  // 互动数据（包含 views，与 judge 保持一致）
  const m = tweet.metrics;
  const metricsStr = m && (m.likes || m.retweets || m.views)
    ? `\nMetrics: likes=${m.likes ?? 0}, retweets=${m.retweets ?? 0}, views=${m.views ?? 0}`
    : '';

  // 来源标签（帮助 reactor 理解信号类型）
  const sourceStr = sourceName ? `\nSource: ${sourceName}` : '';

  // 要求 LLM 严格按照枚举值输出，防止自由填写导致后续校验失败
  const schemaInstruction = `\n\nYou MUST respond with valid JSON: ${buildJsonExample(config.output_schema)}`;

  const user = `Tweet: ${tweet.content}\nAuthor: @${tweet.author}${followersStr}${metricsStr}${sourceStr}\nJudge result: alertLevel=${judgeResult.alertLevel}, reasoning="${judgeResult.reasoning}"${schemaInstruction}`;

  return { system, user };
}

export function assembleReactorSystemPrompt(
  config: ReactorConfig,
  brandContext: string,
  sourceName?: string,
): string {
  const parts = [config.rules];

  if (sourceName && config.source_category_map && config.source_rules) {
    const category = config.source_category_map[sourceName];
    if (category && config.source_rules[category]) {
      parts.push(config.source_rules[category]);
    }
  }

  if (config.priority_rules) {
    parts.push(config.priority_rules);
  }

  if (config.anti_patterns) {
    parts.push(config.anti_patterns);
  }

  parts.push(`---\nBrand Context:\n${brandContext}`);

  return parts.join('\n\n');
}

/**
 * 校验 LLM 返回的回应策略结果是否符合 ReactorResult 类型约束。
 *
 * 同时验证 suggestedAction 和 tones 必须符合 schema 约束。
 *
 * @param result - 待校验的未知对象
 * @returns 若合法则返回 true，并将类型收窄为 ReactorResult
 */
export function validateReactorResult(config: ReactorConfig, result: unknown): result is ReactorResult {
  return validateObjectAgainstSchema(config.output_schema, result);
}

/**
 * LLM 调用函数的类型签名，采用依赖注入方式以便单元测试时替换为 mock。
 *
 * @param system - 系统提示词
 * @param user - 用户消息
 * @returns LLM 原始响应文本
 */
export type LlmCallFn = (system: string, user: string) => Promise<string>;

function getReactorParseFailureReason(
  config: ReactorConfig,
  raw: string,
): string {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return 'No JSON object found in response.';
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (validateReactorResult(config, parsed)) {
        return 'Unknown parse failure.';
      }
      const errors = explainObjectSchemaMismatch(config.output_schema, parsed);
      if (errors.length > 0) {
        return `Schema mismatch: ${errors.join('; ')}`;
      }
    } catch {
      return 'Found JSON-like content but parsing failed.';
    }
  }

  return 'JSON object found, but it did not match the required schema.';
}

function buildReactorRepairPrompt(
  config: ReactorConfig,
  raw: string,
  reason: string,
): { system: string; user: string } {
  return {
    system:
      'Your job is to repair a previous invalid response. Return exactly one valid JSON object and nothing else.',
    user: [
      `Required schema: ${buildJsonExample(config.output_schema)}`,
      `Why the previous response was invalid: ${reason}`,
      'Rewrite the response so it fully matches the schema.',
      'Do not include markdown fences, explanation, rationale, or extra text.',
      'Previous response:',
      raw.slice(0, 1600),
    ].join('\n\n'),
  };
}

/**
 * 解析 LLM 返回的原始文本，提取回应策略结果。
 *
 * 从响应中提取第一个 JSON 对象并校验格式，解析失败则返回 null。
 *
 * @param raw - LLM 返回的原始字符串
 * @returns 解析成功的 ReactorResult，失败时返回 null
 */
function parseReactorResponse(config: ReactorConfig, raw: string): ReactorResult | null {
  try {
    for (const candidate of extractJsonObjects(raw)) {
      const parsed = JSON.parse(candidate);
      if (validateReactorResult(config, parsed)) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析失败时的兜底结果：仅点赞，不主动回复。
 *
 * 选择 like_only 作为最安全的降级策略，避免自动发出不当内容。
 */
const FALLBACK_RESULT: ReactorResult = {
  suggestedAction: 'like_only',
  tones: [{ id: 'casual', label: 'Casual', description: 'Fallback tone' }],
  replyAngle: 'Reactor parse error — fallback to like',
};

/**
 * 针对单条推文生成回应策略，通过 LLM 决定建议动作、语气和回复角度。
 *
 * 解析失败时返回 FALLBACK_RESULT（like_only），LLM 调用异常时返回携带错误信息的降级结果。
 *
 * @param config - Reactor 配置（含规则提示词）
 * @param brandContext - 品牌背景信息
 * @param tweet - 待处理的原始推文
 * @param judgeResult - Judge 对该推文的评判结果
 * @param llmCall - LLM 调用函数（依赖注入）
 * @returns 回应策略结果（suggestedAction、tones、replyAngle）
 */
export async function reactToTweet(
  config: ReactorConfig,
  brandContext: string,
  tweet: RawTweet,
  judgeResult: JudgeResult,
  llmCall: LlmCallFn,
  sourceName?: string,
): Promise<ReactorResult> {
  const prompt = buildReactorPrompt(config, brandContext, tweet, judgeResult, sourceName);

  if (isReactorCircuitOpen()) {
    console.warn('[reactor] Circuit breaker open, skipping LLM call', {
      tweetId: tweet.id,
      sourceName,
      openUntil: reactorCircuitBreaker.openUntil,
    });
    return {
      suggestedAction: 'like_only',
      tones: [{ id: 'casual', label: 'Casual', description: 'Circuit breaker fallback tone' }],
      replyAngle: 'Reactor circuit open — fallback to like',
    };
  }

  try {
    const raw = await llmCall(prompt.system, prompt.user);
    const result = parseReactorResponse(config, raw);
    if (result) {
      recordReactorSuccess();
      return result;
    }

    const failureReason = getReactorParseFailureReason(config, raw);
    console.warn('[reactor] Failed to parse LLM response, attempting format retry', {
      tweetId: tweet.id,
      sourceName,
      reason: failureReason,
      raw: raw.slice(0, 800),
    });

    try {
      const repairPrompt = buildReactorRepairPrompt(config, raw, failureReason);
      const repairedRaw = await llmCall(repairPrompt.system, repairPrompt.user);
      const repairedResult = parseReactorResponse(config, repairedRaw);
      if (repairedResult) {
        recordReactorSuccess();
        return repairedResult;
      }

      console.warn('[reactor] Format retry still failed, using fallback', {
        tweetId: tweet.id,
        sourceName,
        originalReason: failureReason,
        originalRaw: raw.slice(0, 800),
        raw: repairedRaw.slice(0, 800),
      });
    } catch (retryErr) {
      console.warn('[reactor] Format retry request failed, using fallback', {
        tweetId: tweet.id,
        sourceName,
        originalReason: failureReason,
        originalRaw: raw.slice(0, 800),
        error: (retryErr as Error).message,
      });
    }

    recordReactorFailure({ tweetId: tweet.id, sourceName, reason: failureReason });
    return FALLBACK_RESULT;
  } catch (err) {
    recordReactorFailure({
      tweetId: tweet.id,
      sourceName,
      reason: err instanceof Error ? err.message : String(err),
    });
    // LLM 调用本身抛出异常：返回带错误描述的降级结果
    return {
      suggestedAction: 'like_only',
      tones: [{ id: 'casual', label: 'Casual', description: 'Error fallback tone' }],
      replyAngle: `Reactor error: ${(err as Error).message}`,
    };
  }
}

export function resetReactorCircuitBreaker(): void {
  reactorCircuitBreaker.consecutiveFailures = 0;
  reactorCircuitBreaker.openUntil = null;
}
