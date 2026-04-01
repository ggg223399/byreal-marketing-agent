import type { ToneItem } from '../types/index.js';
export type { ToneItem };

// ── 告警级别（Judge 输出） ──

/**
 * 告警级别，由 Judge 模块输出，表示推文对品牌的威胁或机会程度。
 * - `red`：高优先级，需立即响应
 * - `orange`：中高优先级，建议跟进
 * - `yellow`：低优先级，可关注
 * - `none`：无需处理
 */
export type AlertLevel = 'red' | 'orange' | 'yellow' | 'none';

/** 所有合法告警级别的有序数组，用于校验和枚举 */
export const ALERT_LEVELS: AlertLevel[] = ['red', 'orange', 'yellow', 'none'];

// ── 建议动作（Reactor 输出） ──

/**
 * Reactor 模块建议的后续操作类型。
 * - `reply_supportive`：发送支持性回复
 * - `qrt_positioning`：引用转推并附加品牌定位观点
 * - `collab_opportunity`：识别为潜在合作机会，提醒内部跟进
 * - `like_only`：仅点赞，不主动回复
 * - `explore_signal`：发送到探索频道，供团队观察
 * - `escalate_internal`：上报内部团队处理
 * - `none`：不执行任何操作
 */
export type SuggestedAction = 'reply_supportive' | 'qrt_positioning' | 'collab_opportunity' | 'like_only' | 'explore_signal' | 'escalate_internal' | 'none';

/** 所有合法建议动作的有序数组，用于校验和枚举 */
export const SUGGESTED_ACTIONS: SuggestedAction[] = ['reply_supportive', 'qrt_positioning', 'collab_opportunity', 'like_only', 'explore_signal', 'escalate_internal', 'none'];

// ── 语气（Reactor 输出） ──

/**
 * Reactor 模块输出的回复语气风格。
 * - `official`：官方正式语气
 * - `casual`：轻松日常语气
 * - `meme`：梗图/网络文化风格
 * - `technical`：技术性语言
 * - `empathetic`：共情、理解型语气
 */
export type Tone = 'official' | 'casual' | 'meme' | 'technical' | 'empathetic';

/** 所有合法语气类型的有序数组，用于校验和枚举 */
export const TONES: Tone[] = ['official', 'casual', 'meme', 'technical', 'empathetic'];

// ── 数据源配置（sources.yaml） ──

/**
 * 推文预过滤规则，在进入 Judge 前剔除不符合条件的内容。
 */
export interface PreFilter {
  /** 排除包含这些模式的推文（正则或关键词） */
  exclude_patterns?: string[];
  /** 推文内容最小字符数，短于此长度的推文被丢弃 */
  min_length?: number;
}

/**
 * 当 `skip_judge` 为 true 时，对所有推文直接赋予的默认标签。
 */
export interface DefaultLabels {
  /** 默认告警级别 */
  alertLevel: AlertLevel;
  /** 默认建议动作 */
  suggestedAction: SuggestedAction;
}

/**
 * 单个数据源的配置，对应 sources.yaml 中的一项 source 条目。
 */
export interface SourceConfig {
  /** 数据源唯一名称，用于日志和 last_seen 跟踪 */
  name: string;
  /** Cron 表达式，定义该数据源的采集频率 */
  schedule: string;
  /** 发送给 xAI 搜索的提示词模板，支持模板变量替换 */
  prompt: string;
  /** 指向账号列表 YAML 文件的相对路径（可选） */
  accounts_ref?: string;
  /** 当 accounts_ref 指向统一账号清单时，限制只加载这些 group 的账号 */
  groups?: string[];
  /** @deprecated use groups */
  account_groups?: string[];
  /** 直接内联在 source 上的关键词列表，用于 query 型搜索 */
  keywords?: string[];
  /** 若为 true，跳过 LLM Judge 环节，直接使用 default_labels */
  skip_judge?: boolean;
  /** skip_judge 为 true 时生效的默认标签 */
  default_labels?: DefaultLabels;
  /** 推文预过滤规则 */
  pre_filter?: PreFilter;
  /**
   * 搜索时间窗口（分钟）。
   * 决定 `from_date` 的兜底回溯深度：`now - lookback_minutes`。
   * 默认 1440（24 小时）。
   */
  lookback_minutes?: number;
  /**
   * 是否启用 last_seen 增量追踪。
   * - `true`（默认）：`from_date = max(last_seen, now - lookback_minutes)`，每次拉完后更新 last_seen
   * - `false`：每次固定使用 `now - lookback_minutes`，不读写 last_seen
   */
  use_last_seen?: boolean;
  /** 每次搜索最多拉取的推文数量（覆盖全局默认值） */
  max_tweets?: number;
}

/**
 * sources.yaml 顶层结构，包含所有数据源配置列表。
 */
export interface SourcesConfig {
  sources: SourceConfig[];
}

// ── Judge 配置（judge.yaml） ──

/**
 * 枚举类型的 JSON Schema 字段描述，用于约束 LLM 输出为固定候选值之一。
 */
export interface SchemaFieldEnum {
  type: 'enum';
  /** 合法枚举值列表 */
  values: string[];
  /** 字段说明，会注入到 Judge 提示词中 */
  description: string;
}

/**
 * 字符串类型的 JSON Schema 字段描述，用于约束 LLM 输出的字符串长度。
 */
export interface SchemaFieldString {
  type: 'string';
  /** 输出字符串的最大长度 */
  max_length: number;
  /** 字段说明，会注入到 Judge 提示词中 */
  description: string;
}

/**
 * 数组类型的 JSON Schema 字段描述，用于约束 LLM 输出为对象数组。
 * 每个数组元素必须包含 item_fields 指定的所有字符串字段。
 */
export interface SchemaFieldArray {
  type: 'array';
  /** 最少元素数 */
  min_items: number;
  /** 最多元素数 */
  max_items: number;
  /** 每个元素必须包含的字符串字段名列表 */
  item_fields: string[];
  /** 字段说明 */
  description: string;
}

/**
 * Judge 模块配置，定义评判规则及期望的 LLM 输出结构。
 *
 * 支持两种模式：
 * - 简单模式：仅 `rules`（全部规则放一个字段）
 * - 动态裁剪模式：`rules`（通用前言）+ `source_rules`（按类别分段）+ `author_rules`（共用）
 *   运行时只拼装当前 source 对应的那段规则，减少 ~60% token 开销
 */
export interface JudgeConfig {
  /** 通用评判规则前言（简单模式下包含全部规则） */
  rules: string;
  /** 按 source 类别拆分的评判规则，key 为类别名（如 brand / trend / ecosystem） */
  source_rules?: Record<string, string>;
  /** source name → 类别名的映射（如 direct-mentions → brand） */
  source_category_map?: Record<string, string>;
  /** 共用的作者影响力评估规则 */
  author_rules?: string;
  /** LLM 输出的 JSON Schema 约束 */
  output_schema: {
    /** 告警级别字段约束 */
    alertLevel: SchemaFieldEnum;
    /** 评判推理过程字段约束 */
    reasoning: SchemaFieldString;
  };
}

// ── Reactor 配置（reactor.yaml） ──

/**
 * Reactor 模块配置，定义品牌上下文引用、响应规则及期望的 LLM 输出结构。
 */
export interface ReactorConfig {
  /** 品牌上下文文件的相对路径，内容会注入到 Reactor 提示词 */
  brand_context_ref: string;
  /** 通用响应策略规则文本，始终注入到系统提示词 */
  rules: string;
  /** 按 source 类别拆分的响应规则 */
  source_rules?: Record<string, string>;
  /** source name → 类别名的映射 */
  source_category_map?: Record<string, string>;
  /** 跨 source 的冲突优先级规则 */
  priority_rules?: string;
  /** 通用反模式/禁止项 */
  anti_patterns?: string;
  /** LLM 输出的 JSON Schema 约束 */
  output_schema: {
    /** 建议动作字段约束 */
    suggestedAction: SchemaFieldEnum;
    /** 回复角度/切入点字段约束 */
    replyAngle: SchemaFieldString;
    /** 2-3 个语气选项 */
    tones: SchemaFieldArray;
  };
}

// ── 路由配置（routing.yaml） ──

/**
 * 路由匹配条件，支持单个值或值数组（OR 语义）。
 */
export interface RouteMatch {
  /** 匹配的告警级别（单值或数组） */
  alertLevel?: AlertLevel | AlertLevel[];
  /** 匹配的建议动作（单值或数组） */
  suggestedAction?: SuggestedAction | SuggestedAction[];
}

/**
 * 单条路由规则，定义信号如何被分发到目标渠道。
 */
export interface RouteRule {
  /** 正向匹配条件：满足时路由到 channel */
  match?: RouteMatch;
  /** 反向匹配条件：不满足时路由到 channel */
  match_not?: RouteMatch;
  channel: string;
  /** 目标渠道名称（如 discord_red、discord_general） */
  /** 为 true 时命中后继续匹配后续规则（默认为 false，命中即停止） */
  continue?: boolean;
}

/**
 * routing.yaml 顶层结构，包含路由规则列表和默认渠道配置。
 */
export interface RoutingConfig {
  routing: {
    /** 无规则命中时的兜底渠道 */
    default: { channel: string };
    /** 有序路由规则列表，按顺序匹配 */
    routes: RouteRule[];
    /** 去重键字段列表，用于防止同一信号被重复路由 */
    dedup_key?: string[];
  };
}

// ── 富化配置（enrichment.yaml） ──

/**
 * 热门推文检测阈值配置，用于判断信号是否达到"趋势"级别。
 */
export interface TrendingConfig {
  /** 是否启用趋势检测 */
  enabled: boolean;
  /** 趋势推文的发布渠道名称 */
  channel: string;
  /** 指标阈值，超过任一阈值即视为趋势 */
  thresholds: {
    /** 浏览量阈值 */
    views: number;
    /** 点赞数阈值 */
    likes: number;
    /** 转推数阈值 */
    retweets: number;
  };
}

/**
 * enrichment.yaml 顶层结构，定义信号富化（指标回填）的调度参数。
 */
export interface EnrichmentConfig {
  enrichment: {
    /** 是否启用指标富化 */
    enabled: boolean;
    /** 信号入库后延迟多少分钟才开始富化 */
    delay_minutes: number;
    /** 富化任务的 Cron 表达式 */
    schedule: string;
    /** 每批处理的信号数量 */
    batch_size: number;
    /** 超过此小时数的旧信号不再富化 */
    max_age_hours: number;
    /** 趋势检测配置 */
    trending: TrendingConfig;
  };
}

// ── 运行时数据结构 ──

/**
 * 从 xAI 搜索 API 获取的原始推文数据。
 */
export interface RawTweet {
  /** 推文唯一 ID */
  id: string;
  /** 作者 handle（不带 @ 前缀） */
  author: string;
  /** 推文正文内容 */
  content: string;
  /** 推文原始链接 */
  url: string;
  /** 推文发布时间戳（Unix 秒） */
  created_at: number;
  /** 推文互动指标（可能缺失） */
  metrics?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number;
  };
  /** 扩展元数据，供下游模块附加信息 */
  metadata?: Record<string, unknown>;
}

/**
 * Judge 模块对单条推文的评判结果。
 */
export interface JudgeResult {
  /** 告警级别 */
  alertLevel: AlertLevel;
  /** LLM 给出的评判推理说明 */
  reasoning: string;
}

/**
 * Reactor 模块对单条推文的响应建议结果。
 */
export interface ReactorResult {
  /** 建议的后续操作 */
  suggestedAction: SuggestedAction;
  /** 回复角度/切入点描述 */
  replyAngle: string;
  /** 2-3 个语气选项，第一个为推荐 */
  tones: ToneItem[];
}

/**
 * 经过完整 pipeline（搜索 → 过滤 → Judge → Reactor）处理后的最终信号，
 * 准备写入 DB 并路由到目标渠道。
 */
export interface ProcessedSignal {
  /** 触发此信号的原始推文 */
  tweet: RawTweet;
  /** 来源数据源名称 */
  sourceName: string;
  /** 告警级别 */
  alertLevel: AlertLevel;
  /** Judge 推理说明 */
  reasoning: string;
  /** 建议动作 */
  suggestedAction: SuggestedAction;
  /** 2-3 个语气选项 */
  tones: ToneItem[];
  /** 回复角度描述 */
  replyAngle: string;
}
