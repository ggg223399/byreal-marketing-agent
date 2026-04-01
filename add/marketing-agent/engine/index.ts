import path from 'node:path';
import { loadAllConfigs, loadAccountsList, loadBrandContext, resolveConfigRefPath } from './config-loader.js';
import { buildCronJobs, startAllJobs, stopAllJobs, type CronJob } from './cron.js';
import { processSource } from './pipeline.js';
import { judgeTweets } from './judge.js';
import { reactToTweet } from './reactor.js';
import { resolveChannels as resolveSignalChannels } from './router.js';
import { createEnrichmentJob, type EnrichmentJob } from './enrichment.js';
import type { SourceConfig, RawTweet, JudgeConfig, ReactorConfig, ProcessedSignal } from './types.js';
import { callClaudeText } from '../../src/claude-sdk.js';
import {
  searchWithTool,
  toNormalizedHandle,
  chunk,
  INTER_CALL_DELAY_MS,
  MAX_HANDLES_PER_CALL,
  DEFAULT_MAX_TWEETS_PER_QUERY,
} from '../collector/adapters/xai-search.js';
import { getConfigOverride, setConfigOverride, insertV5Signal, writeHeartbeat } from '../db/index.js';

/** 默认配置目录（相对于 process.cwd()） */
const DEFAULT_CONFIG_DIR = 'marketing-agent/config';

/** 默认使用的 LLM 模型 ID */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * 简单的异步延迟工具函数。
 * @param ms 等待毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 严格过滤超出窗口的旧推文。
 * xAI Search 的 `from_date` 和 prompt 约束都不是强保证，因此这里再做一次硬校验。
 */
export function filterTweetsByCreatedAt(tweets: RawTweet[], minCreatedAtSeconds: number): RawTweet[] {
  return tweets.filter((tweet) => Number.isFinite(tweet.created_at) && tweet.created_at >= minCreatedAtSeconds);
}

/**
 * 创建 Judge/Reactor 共用的 LLM 调用适配器。
 * 将 `callClaudeText` 的参数签名收窄为 `(system, user) => Promise<string>`，
 * 方便在 judge 和 reactor 模块中以统一接口调用。
 *
 * @param model 使用的 Claude 模型 ID
 * @returns 接收系统提示和用户提示、返回文本响应的异步函数
 */
function makeLlmCall(model: string) {
  return async (system: string, user: string): Promise<string> => {
    return callClaudeText({
      systemPrompt: system,
      userPrompt: user,
      model,
      temperature: 0,      // 评判和响应任务要求确定性输出，temperature 固定为 0
      maxTokens: 1024,
    });
  };
}

/**
 * `createEngine` 的配置选项。
 */
export interface EngineOptions {
  /** 配置文件目录，默认为 `marketing-agent/config` */
  configDir?: string;
  /** 使用的 Claude 模型 ID，默认为 `claude-sonnet-4-6` */
  model?: string;
  /**
   * 干跑模式：启用后不会执行真实搜索和 DB 写入，
   * 仅在控制台打印将要执行的操作，用于调试。
   */
  dryRun?: boolean;
  /** 每次搜索请求最多获取的推文数量 */
  maxTweetsPerQuery?: number;
  /**
   * 信号路由完成后的回调，可用于外部监听或额外处理。
   * @param signal 已处理的信号对象
   * @param channels 路由目标渠道列表
   */
  onSignalRouted?: (signal: ProcessedSignal, channels: string[]) => void;
}

/**
 * Engine 实例接口，对外暴露启动、停止和按名称运行数据源三个操作。
 */
export interface Engine {
  /** 启动所有 cron 数据源任务和富化任务 */
  start(): void;
  /** 停止所有正在运行的任务并释放资源 */
  stop(): void;
  /**
   * 立即手动触发指定数据源运行一次（不受 cron 调度约束）。
   * @param sourceName 数据源名称，须与 sources.yaml 中的 name 字段一致
   */
  runSource(sourceName: string): Promise<void>;
}

/**
 * 创建并返回一个 v5 信号 pipeline 引擎实例。
 *
 * 引擎封装了完整的信号处理流程：
 * 1. 按 cron 调度从 xAI Responses API 搜索推文
 * 2. 经 pre-filter 粗过滤
 * 3. 使用 Judge LLM 评判告警级别
 * 4. 使用 Reactor LLM 生成响应建议
 * 5. 按路由规则写入 DB，由 discord.ts 轮询发送
 * 6. 定期富化已存信号的互动指标
 *
 * @param options 引擎配置选项
 * @returns Engine 实例
 */
export function createEngine(options: EngineOptions = {}): Engine {
  const configDir = path.resolve(process.cwd(), options.configDir ?? DEFAULT_CONFIG_DIR);
  const model = options.model ?? DEFAULT_MODEL;
  const dryRun = options.dryRun ?? false;
  const maxTweetsPerQuery = options.maxTweetsPerQuery ?? DEFAULT_MAX_TWEETS_PER_QUERY;
  const llmCall = makeLlmCall(model);

  // xAI Responses API 密钥，从环境变量读取
  const apiKey = process.env.DATA_SOURCE_API_KEY ?? '';

  /**
   * 热加载所有配置文件。
   * 每次数据源运行前调用，以支持配置的无重启更新。
   */
  function reloadConfigs() {
    const configs = loadAllConfigs(configDir);
    const brandContextPath = path.resolve(configDir, configs.reactor.brand_context_ref);
    let brandContext: string;
    try {
      brandContext = loadBrandContext(brandContextPath);
    } catch {
      // 品牌上下文文件不存在时降级为空字符串，不中断流程
      console.warn(`[engine] Brand context not found at ${brandContextPath}, using empty`);
      brandContext = '';
    }
    return { configs, brandContext };
  }

  // 初始加载，供 start() 读取数据源列表
  let { configs, brandContext } = reloadConfigs();

  /**
   * 从数据源内联关键词中构建提示词模板变量。
   *
   * @param source 数据源配置
   * @returns 模板变量字典
   */
  function getTemplateVars(source: SourceConfig): Record<string, string> {
    const vars: Record<string, string> = {};
    if (source.keywords && source.keywords.length > 0) {
      vars.keywords = source.keywords.join(', ');
      vars.active_keywords = vars.keywords;
    }
    return vars;
  }

  /**
   * 从数据源的 accounts_ref YAML 文件加载账号 handle 列表，
   * 并规范化为小写、去 @ 前缀格式。
   *
   * @param source 数据源配置
   * @returns 规范化后的 handle 数组，不含空字符串
   */
  function loadHandles(source: SourceConfig): string[] {
    if (!source.accounts_ref) return [];
    const accountsPath = resolveConfigRefPath(configDir, source.accounts_ref);
    try {
      return loadAccountsList(accountsPath, {
        groups: source.groups ?? source.account_groups,
      }).map(toNormalizedHandle).filter(Boolean);
    } catch {
      console.warn(`[engine] Accounts file not found: ${accountsPath}`);
      return [];
    }
  }

  /**
   * 为指定数据源构建搜索函数，绑定到 xAI Responses API。
   *
   * 搜索函数会：
   * - 根据 `last_seen` 记录决定起始时间，避免重复拉取历史推文
   * - 若有账号列表，分批搜索（每批 MAX_HANDLES_PER_CALL 个）
   * - 对结果执行二次 handle 过滤（因 Grok API 的 allowed_x_handles 非严格限制）
   * - 更新 `last_seen` 时间戳到 DB
   *
   * @param source 数据源配置
   * @returns 接收提示词、返回原始推文数组的异步函数
   */
  function makeSearchFn(source: SourceConfig): (prompt: string) => Promise<RawTweet[]> {
    return async (prompt: string): Promise<RawTweet[]> => {
      if (dryRun) {
        console.log(`[dry-run] Would search: ${prompt.slice(0, 80)}...`);
        return [];
      }

      if (!apiKey) {
        console.warn(`[engine] No DATA_SOURCE_API_KEY set, skipping search for "${source.name}"`);
        return [];
      }

      // 计算搜索起始时间
      const lookbackMs = (source.lookback_minutes ?? 24 * 60) * 60 * 1000;
      const useLastSeen = source.use_last_seen !== false;
      const lastSeenKey = `engine_last_seen_${source.name}`;
      let fromDate = new Date(Date.now() - lookbackMs);

      if (useLastSeen) {
        const lastSeenTs = getConfigOverride(lastSeenKey);
        if (lastSeenTs) {
          const lastSeenDate = new Date(parseInt(lastSeenTs, 10) * 1000);
          // 只有当 last_seen 比回溯起点更晚时才使用，避免倒退
          if (lastSeenDate > fromDate) {
            fromDate = lastSeenDate;
          }
        }
      }

      const allTweets: RawTweet[] = [];
      const handles = loadHandles(source);
      const cutoffIso = fromDate.toISOString().replace('.000Z', 'Z');
      const minCreatedAtSeconds = Math.floor(fromDate.getTime() / 1000);

      // per-source max_tweets 覆盖全局默认值
      const tweetsLimit = source.max_tweets ?? maxTweetsPerQuery;

      if (handles.length > 0) {
        // 账号列表按批次搜索，批次间插入延迟以避免触发 API 限流
        const batches = chunk(handles, MAX_HANDLES_PER_CALL);
        for (let i = 0; i < batches.length; i++) {
          if (i > 0) await sleep(INTER_CALL_DELAY_MS); // 批次间限流延迟

          const batch = batches[i];
          const constrainedPrompt = [
            prompt,
            '',
            `Search for tweets from these exact X handles only: ${batch.join(', ')}.`,
            `Only return tweets posted after ${cutoffIso}.`,
            'Do NOT return tweets from any other accounts.',
            'Do NOT return tweets older than the cutoff even if they seem more relevant or popular.',
            'If no matching tweets exist, return {"tweets":[]}.',
          ].join('\n');
          const tweets = await searchWithTool(apiKey, constrainedPrompt, {
            type: 'x_search',
            allowed_x_handles: batch,
            from_date: fromDate.toISOString(),
          }, tweetsLimit);
          allTweets.push(...filterTweetsByCreatedAt(tweets, minCreatedAtSeconds));
        }
      } else {
        // 无账号列表时，仅凭关键词/提示词进行全局搜索
        const constrainedPrompt = [
          prompt,
          '',
          `Only return tweets posted after ${cutoffIso}.`,
          'Do NOT return tweets older than the cutoff even if they seem more relevant or popular.',
          'If no matching tweets exist, return {"tweets":[]}.',
        ].join('\n');
        const tweets = await searchWithTool(apiKey, constrainedPrompt, {
          type: 'x_search',
          from_date: fromDate.toISOString(),
        }, tweetsLimit);
        allTweets.push(...filterTweetsByCreatedAt(tweets, minCreatedAtSeconds));
      }

      // 二次 handle 过滤：Grok 的 allowed_x_handles 参数仅作建议，非严格限制，
      // 可能返回不在列表中的账号推文，此处将其过滤掉
      let verified = allTweets;
      if (handles.length > 0) {
        const handleSet = new Set(handles.map(h => h.toLowerCase()));
        const before = verified.length;
        verified = verified.filter(t => {
          const tHandle = t.author.replace(/^@/, '').toLowerCase();
          return handleSet.has(tHandle);
        });
        if (verified.length < before) {
          console.log(`[engine] Handle filter for "${source.name}": kept ${verified.length}/${before} tweets`);
        }
      }

      if (verified.length < allTweets.length) {
        console.log(`[engine] Freshness filter for "${source.name}": kept ${verified.length}/${allTweets.length} tweets`);
      }

      // 更新 last_seen：仅在 use_last_seen 模式下写入
      if (useLastSeen && verified.length > 0) {
        const maxCreatedAt = Math.max(...verified.map(t => t.created_at));
        setConfigOverride(lastSeenKey, String(maxCreatedAt));
      }

      return verified;
    };
  }

  /**
   * 单个数据源的处理入口，由 cron 任务调用。
   * 执行热加载配置 → 调用 pipeline → 写入 heartbeat 三个步骤。
   *
   * @param source 要处理的数据源配置
   */
  async function handleSource(source: SourceConfig): Promise<void> {
    const startTime = Date.now();
    console.log(`[engine] Running source "${source.name}"...`);

    // 每次运行前热加载配置，失败时沿用上一次缓存，保证服务不中断
    try {
      ({ configs, brandContext } = reloadConfigs());
    } catch (err) {
      console.error(`[engine] Config reload failed, using cached:`, err);
    }

    try {
      const result = await processSource({
        source,
        searchFn: makeSearchFn(source),
        judgeFn: async (judgeConfig: JudgeConfig, tweets: RawTweet[], sourceName: string) => {
          return judgeTweets(judgeConfig, tweets, llmCall, sourceName);
        },
        reactFn: async (reactorConfig: ReactorConfig, ctx: string, tweet: RawTweet, judgeResult, sourceName: string) => {
          return reactToTweet(reactorConfig, ctx, tweet, judgeResult, llmCall, sourceName);
        },
        routeFn: (signal: ProcessedSignal, channels: string[]) => {
          if (dryRun) {
            // 干跑模式：打印路由信息但不写 DB
            console.log(`[dry-run] Would route to ${channels.join(', ')}: @${signal.tweet.author} — ${signal.tweet.content.slice(0, 60)}`);
            return;
          }

          // 将信号写入 DB，discord.ts 的轮询逻辑会取出并附带互动按钮发送
          try {
            insertV5Signal({
              tweetId: signal.tweet.id,
              author: signal.tweet.author,
              content: signal.tweet.content,
              url: signal.tweet.url,
              resolvedChannels: channels,
              sourceName: signal.sourceName,
              alertLevel: signal.alertLevel,
              suggestedAction: signal.suggestedAction,
              tones: signal.tones,
              replyAngle: signal.replyAngle,
              judgeReasoning: signal.reasoning,
              rawJson: JSON.stringify(signal.tweet),
            });
          } catch (err) {
            console.error(`[engine] DB insert error for @${signal.tweet.author}:`, err);
            throw err;
          }

          // 触发外部回调（如有）
          if (options.onSignalRouted) {
            options.onSignalRouted(signal, channels);
          }
        },
        judgeConfig: configs.judge,
        reactorConfig: configs.reactor,
        routingConfig: configs.routing,
        brandContext,
        templateVars: getTemplateVars(source),
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[engine] Source "${source.name}" done in ${elapsed}s: ` +
        `searched=${result.totalSearched} filtered=${result.filteredByPreFilter} ` +
        `none=${result.judgedNone} routed=${result.routed}`
      );

      // 写入心跳记录，供监控面板查看各数据源的运行状态
      writeHeartbeat(source.name, {
        elapsed,
        searched: result.totalSearched,
        filtered: result.filteredByPreFilter,
        none: result.judgedNone,
        routed: result.routed,
      });
    } catch (err) {
      console.error(`[engine] Error in source "${source.name}":`, err);
      // 出错时也写入心跳，便于快速发现异常数据源
      writeHeartbeat(source.name, { error: String(err) });
    }
  }

  // 运行时状态：当前活跃的 cron 任务列表和富化任务
  let cronJobs: CronJob[] = [];
  let enrichmentJob: EnrichmentJob | null = null;

  /**
   * 使用 xAI API 查询指定推文的最新互动指标。
   * 由富化任务调用，用于回填 DB 中信号的 metrics 字段。
   *
   * @param tweetId 推文 ID
   * @param tweetUrl 推文原始链接（优先使用，比 ID 搜索更准确）
   * @returns 包含 likes/retweets/replies/views 的指标对象，失败时返回 null
   */
  async function fetchTweetMetrics(tweetId: string, tweetUrl?: string) {
    if (!apiKey) return null;

    // 优先用 URL 查询，更精准；回退到 ID 查询
    const query = tweetUrl
      ? `Find the exact tweet at this URL: ${tweetUrl}. Return its current metrics.`
      : `Find the tweet with ID ${tweetId}. Return its current metrics.`;

    try {
      // 只需要 1 条结果，查询时间窗口设为最近 7 天
      const tweets = await searchWithTool(apiKey, query, {
        type: 'x_search',
        from_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      }, 1);

      if (tweets.length === 0) return null;
      const m = tweets[0].metrics;
      return {
        likes: m?.likes ?? 0,
        retweets: m?.retweets ?? 0,
        replies: m?.replies ?? 0,
        views: m?.views ?? 0,
      };
    } catch (err) {
      console.warn(`[engine] Metric fetch failed for ${tweetId}:`, err);
      return null;
    }
  }

  return {
    start() {
      // 启动时打印配置摘要，便于快速确认配置是否正确加载
      console.log(`[engine] Config: ${configDir}`);
      console.log(`[engine] Model: ${model}`);
      console.log(`[engine] Sources: ${configs.sources.sources.map(s => `${s.name}(${s.schedule})`).join(', ')}`);
      console.log(`[engine] Routes: ${configs.routing.routing.routes.length} rules, default → ${configs.routing.routing.default.channel}`);

      // 为每个数据源创建 cron 任务并启动
      cronJobs = buildCronJobs(configs.sources.sources, handleSource);
      startAllJobs(cronJobs);
      console.log(`[engine] Started ${cronJobs.length} source jobs`);

      // 启动富化任务（定期回填互动指标）
      enrichmentJob = createEnrichmentJob(
        configs.enrichment,
        fetchTweetMetrics,
        (signal) => resolveSignalChannels(signal, configs.routing),
      );
      enrichmentJob.start();
    },

    stop() {
      // 停止所有 cron 任务并清空列表
      stopAllJobs(cronJobs);
      cronJobs = [];
      if (enrichmentJob) {
        enrichmentJob.stop();
        enrichmentJob = null;
      }
      console.log('[engine] Stopped');
    },

    async runSource(sourceName: string) {
      // 手动触发前先热加载，以获取最新数据源列表
      try {
        ({ configs, brandContext } = reloadConfigs());
      } catch { /* 加载失败时沿用缓存，静默处理 */ }

      const source = configs.sources.sources.find(s => s.name === sourceName);
      if (!source) {
        throw new Error(`Source not found: ${sourceName}. Available: ${configs.sources.sources.map(s => s.name).join(', ')}`);
      }
      await handleSource(source);
    },
  };
}
