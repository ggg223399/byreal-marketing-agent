import type {
  SourceConfig, JudgeConfig, ReactorConfig, RoutingConfig,
  RawTweet, JudgeResult, ReactorResult, ProcessedSignal,
} from './types.js';
import { applyPreFilter, resolveSourcePrompt } from './searcher.js';
import { resolveChannels } from './router.js';

/**
 * `processSource` 函数所需的依赖注入参数。
 * 通过接口注入而非直接调用，便于单元测试时 mock 各阶段函数。
 *
 * - `source`         当前处理的 source 配置
 * - `searchFn`       搜索推文的函数（可传入可选的 handles 列表）
 * - `judgeFn`        批量判断推文相关性的函数，返回 id→JudgeResult 的 Map
 * - `reactFn`        针对单条推文生成回应建议的函数
 * - `routeFn`        将已处理的信号推送到指定渠道的函数
 * - `judgeConfig`    judge 阶段使用的配置
 * - `reactorConfig`  reactor 阶段使用的配置
 * - `routingConfig`  路由规则配置
 * - `brandContext`   品牌上下文文本，供 reactor 生成回复时参考
 * - `templateVars`   用于替换 prompt 中 `{{key}}` 占位符的变量表
 */
export interface ProcessSourceDeps {
  source: SourceConfig;
  searchFn: (prompt: string, handles?: string[]) => Promise<RawTweet[]>;
  judgeFn: (config: JudgeConfig, tweets: RawTweet[], sourceName: string) => Promise<Map<string, JudgeResult>>;
  reactFn: (config: ReactorConfig, brandContext: string, tweet: RawTweet, judgeResult: JudgeResult, sourceName: string) => Promise<ReactorResult>;
  routeFn: (signal: ProcessedSignal, channels: string[]) => void;
  judgeConfig: JudgeConfig;
  reactorConfig: ReactorConfig;
  routingConfig: RoutingConfig;
  brandContext: string;
  templateVars: Record<string, string>;
}

/**
 * `processSource` 的执行统计结果，用于监控和日志记录。
 *
 * - `sourceName`        source 名称
 * - `totalSearched`     搜索到的推文总数
 * - `filteredByPreFilter` 被预过滤器过滤掉的推文数
 * - `judgedNone`        经 judge 判定为无关联（alertLevel='none'）的推文数
 * - `routed`            最终成功路由的推文数
 */
export interface ProcessSourceResult {
  sourceName: string;
  totalSearched: number;
  filteredByPreFilter: number;
  judgedNone: number;
  routed: number;
}

/**
 * 执行单个 source 的完整处理流水线：搜索 → 预过滤 → 判断 → 反应 → 路由。
 *
 * 流水线步骤：
 * 1. **Search**：用解析后的 prompt 调用 searchFn 获取原始推文
 * 2. **Pre-filter**：按 source.pre_filter 规则去除噪声推文
 * 3. **skip_judge 快速路径**：若 source 配置了 skip_judge，直接使用 default_labels 构建信号并路由
 * 4. **Judge**：批量调用 judgeFn，获取每条推文的相关性评级
 * 5. **Reactor + Route**：对非 none 的推文调用 reactFn 生成回应建议，再通过 routeFn 推送到渠道
 *
 * @param deps 依赖注入参数，见 `ProcessSourceDeps`
 * @returns 本次执行的统计数据，见 `ProcessSourceResult`
 */
export async function processSource(deps: ProcessSourceDeps): Promise<ProcessSourceResult> {
  const { source, searchFn, judgeFn, reactFn, routeFn, judgeConfig, reactorConfig, brandContext, templateVars } = deps;

  const result: ProcessSourceResult = {
    sourceName: source.name,
    totalSearched: 0,
    filteredByPreFilter: 0,
    judgedNone: 0,
    routed: 0,
  };

  // 1. Search：将 prompt 模板变量展开后执行搜索
  const prompt = resolveSourcePrompt(source.prompt, templateVars);
  const tweets = await searchFn(prompt);
  result.totalSearched = tweets.length;

  // 若搜索结果为空，提前返回，无需继续后续步骤
  if (tweets.length === 0) return result;

  // 2. Pre-filter：过滤掉不符合规则的推文（如排除模式、最小长度等）
  const filtered = applyPreFilter(tweets, source.pre_filter);
  result.filteredByPreFilter = tweets.length - filtered.length;

  // 预过滤后为空，提前返回
  if (filtered.length === 0) return result;

  // 3. skip_judge 快速路径：跳过 LLM 判断，直接使用配置的默认标签构建信号
  if (source.skip_judge && source.default_labels) {
    for (const tweet of filtered) {
      const signal: ProcessedSignal = {
        tweet,
        sourceName: source.name,
        alertLevel: source.default_labels.alertLevel,
        reasoning: 'skip_judge — default labels',
        suggestedAction: source.default_labels.suggestedAction,
        tones: [{ id: 'official', label: 'Official', description: 'Default formal tone' }],
        replyAngle: '',
      };
      const channels = resolveChannels(signal, deps.routingConfig);
      routeFn(signal, channels);
      result.routed++;
    }
    return result;
  }

  // 4. Judge：批量调用 LLM 判断推文的相关性和警报级别
  const judgeResults = await judgeFn(judgeConfig, filtered, source.name);

  // 5. 对每条推文逐一处理：过滤 none 级别，对有效推文执行 Reactor 并路由
  for (const tweet of filtered) {
    const judgeResult = judgeResults.get(tweet.id);
    // alertLevel='none' 表示该推文与品牌无关，跳过
    if (!judgeResult || judgeResult.alertLevel === 'none') {
      result.judgedNone++;
      continue;
    }

    // Reactor：根据 judgeResult 生成具体的回应建议（动作、语气、回复角度）
    const reactorResult = await reactFn(reactorConfig, brandContext, tweet, judgeResult, source.name);

    // 组装最终的 ProcessedSignal，汇集搜索、judge、reactor 的所有输出
    const signal: ProcessedSignal = {
      tweet,
      sourceName: source.name,
      alertLevel: judgeResult.alertLevel,
      reasoning: judgeResult.reasoning,
      suggestedAction: reactorResult.suggestedAction,
      tones: reactorResult.tones,
      replyAngle: reactorResult.replyAngle,
    };

    // 根据路由配置决定推送到哪些渠道
    const channels = resolveChannels(signal, deps.routingConfig);
    routeFn(signal, channels);
    result.routed++;
  }

  return result;
}
