import { resolveMarketingConfigDir } from '../../marketing-agent/config/runtime.js';

export type MarketingPipeline = 'mentions' | 'network' | 'trends' | 'crisis';
export type MarketingActionType =
  | 'reply'
  | 'qrt'
  | 'like'
  | 'monitor'
  | 'skip'
  | 'statement';
export type MarketingAlertLevel = 'red' | 'orange' | 'yellow' | 'none';
export type MarketingSuggestedAction =
  | 'reply_supportive'
  | 'qrt_positioning'
  | 'collab_opportunity'
  | 'like_only'
  | 'explore_signal'
  | 'escalate_internal'
  | 'none';
export type MarketingFeedbackType =
  | 'not_relevant'
  | 'wrong_category'
  | 'low_quality'
  | 'duplicate'
  | 'good_signal';

export interface MarketingTone {
  id: string;
  label: string;
  description: string;
}

export interface MarketingSignal {
  id: number;
  tweetId: string;
  author: string;
  content: string;
  url?: string;
  pipeline: MarketingPipeline;
  pipelines: MarketingPipeline[];
  actionType: MarketingActionType;
  angle: string;
  tones: MarketingTone[];
  connection?: string;
  accountTier?: string;
  severity?: string;
  reason: string;
  sourceAdapter: string;
  rawJson?: string;
  resolvedChannels: string[];
  createdAt: number;
  notifiedAt?: number;
  sourceName?: string;
  alertLevel?: MarketingAlertLevel;
  suggestedAction?: MarketingSuggestedAction;
  v5Tone?: string;
  replyAngle?: string;
  judgeReasoning?: string;
}

export type MarketingSignalLike = Omit<MarketingSignal, 'tones'> & {
  tones: MarketingTone[] | string;
};

export interface MarketingFeedbackDigest {
  totalFeedback: number;
  topSources: Array<{ sourceName: string; count: number }>;
}

export interface MarketingSignalSummary {
  totalSignals: number;
  pipelineCounts: Record<MarketingPipeline, number>;
}

export interface MarketingSignalDispatch {
  signal: MarketingSignal;
  targetChannels: string[];
  isInteractive: boolean;
}

export interface RecordMarketingSignalFeedbackInput {
  signalId: number;
  feedbackType: MarketingFeedbackType | string;
  feedbackBy?: string;
  sourceName?: string;
  alertLevel?: string;
  suggestedAction?: string;
  resolvedChannels?: string[];
  tweetId?: string;
  snapshotJson?: string;
}

export interface RecordMarketingFeedbackEventInput {
  signal: MarketingSignal;
  feedbackType: MarketingFeedbackType | string;
  feedbackBy?: string;
}

export interface GenerateMarketingDraftRequestInput {
  signal: MarketingSignalLike;
  toneId?: string;
  toneInput?: string;
  context?: string;
  configDir?: string;
}

export interface GenerateMarketingDraftRequestResult {
  tone: MarketingTone;
  toneLabel: string;
  draftText: string;
  usedFallbackTone: boolean;
}

export interface RecordMarketingEmojiReactionInput {
  messageId: string;
  emoji: '👍' | '👎' | '🤔';
  userId: string;
  username?: string;
  channelId: string;
}

export interface RecordMarketingEmojiReactionResult {
  confirmationMessage: string;
}

interface MarketingDbModule {
  getSignalById(id: number): MarketingSignal | null;
  getUnnotifiedSignals(limit?: number): MarketingSignal[];
  getSignalsSince(epochSeconds: number): MarketingSignal[];
  markSignalNotified(signalId: number): void;
  recordSignalFeedback(input: RecordMarketingSignalFeedbackInput): void;
  logAudit(actionType: string, details?: Record<string, unknown>): void;
}

interface MarketingRouterModule {
  resolveChannels(
    signal: MarketingProcessedSignal,
    config: MarketingRoutingConfig,
  ): string[];
}

interface MarketingConfigModule {
  loadAllConfigs(configDir: string): { routing: MarketingRoutingConfig };
}

interface MarketingGeneratorModule {
  loadGeneratorRuntimeConfig(configDir?: string): void;
  generateSingleToneDraft(
    signal: MarketingSignal,
    tone: string,
    context?: string,
  ): Promise<string>;
}

interface MarketingFeedbackModule {
  generateDailyFeedbackDigest(targetDate?: Date): MarketingFeedbackDigest;
  formatDailyFeedbackDigest(digest: MarketingFeedbackDigest): string;
}

interface MarketingRoutingConfig {
  routes: Array<Record<string, unknown>>;
  default_channel: string;
}

interface MarketingProcessedSignal {
  tweet: {
    id: string;
    author: string;
    content: string;
    url: string;
    created_at: number;
  };
  sourceName: string;
  alertLevel: MarketingAlertLevel;
  reasoning: string;
  suggestedAction: MarketingSuggestedAction;
  tones: MarketingTone[];
  replyAngle: string;
}

let dbModulePromise: Promise<MarketingDbModule | null> | null = null;
let routerModulePromise: Promise<MarketingRouterModule | null> | null = null;
let configModulePromise: Promise<MarketingConfigModule | null> | null = null;
let generatorModulePromise: Promise<MarketingGeneratorModule | null> | null =
  null;
let feedbackModulePromise: Promise<MarketingFeedbackModule | null> | null =
  null;

async function importOptional<T>(loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch {
    return null;
  }
}

function loadDbModule(): Promise<MarketingDbModule | null> {
  dbModulePromise ??= importOptional(
    async () =>
      (await import('../../marketing-agent/db/index.js')) as MarketingDbModule,
  );
  return dbModulePromise;
}

function loadRouterModule(): Promise<MarketingRouterModule | null> {
  routerModulePromise ??= importOptional(
    async () =>
      (await import('../../marketing-agent/engine/router.js')) as unknown as MarketingRouterModule,
  );
  return routerModulePromise;
}

function loadConfigModule(): Promise<MarketingConfigModule | null> {
  configModulePromise ??= importOptional(
    async () =>
      (await import('../../marketing-agent/engine/config-loader.js')) as unknown as MarketingConfigModule,
  );
  return configModulePromise;
}

function loadGeneratorModule(): Promise<MarketingGeneratorModule | null> {
  generatorModulePromise ??= importOptional(
    async () =>
      (await import('../../marketing-agent/generator/draft.js')) as MarketingGeneratorModule,
  );
  return generatorModulePromise;
}

function loadFeedbackModule(): Promise<MarketingFeedbackModule | null> {
  feedbackModulePromise ??= importOptional(
    async () =>
      (await import('../../marketing-agent/digest/feedback.js')) as MarketingFeedbackModule,
  );
  return feedbackModulePromise;
}

export async function isMarketingAgentSidecarAvailable(): Promise<boolean> {
  return (await loadDbModule()) !== null;
}

export async function getMarketingSignalById(
  signalId: number,
): Promise<MarketingSignal | null> {
  const dbModule = await loadDbModule();
  return dbModule?.getSignalById(signalId) ?? null;
}

export async function getMarketingUnnotifiedSignals(
  limit = 20,
): Promise<MarketingSignal[]> {
  const dbModule = await loadDbModule();
  return dbModule?.getUnnotifiedSignals(limit) ?? [];
}

export async function getMarketingSignalsSince(
  epochSeconds: number,
): Promise<MarketingSignal[]> {
  const dbModule = await loadDbModule();
  return dbModule?.getSignalsSince(epochSeconds) ?? [];
}

export async function getMarketingSignalSummary(
  epochSeconds: number,
): Promise<MarketingSignalSummary> {
  const signals = await getMarketingSignalsSince(epochSeconds);
  const pipelineCounts: Record<MarketingPipeline, number> = {
    mentions: 0,
    network: 0,
    trends: 0,
    crisis: 0,
  };

  for (const signal of signals) {
    pipelineCounts[signal.pipeline] += 1;
  }

  return {
    totalSignals: signals.length,
    pipelineCounts,
  };
}

export async function markMarketingSignalNotified(
  signalId: number,
): Promise<void> {
  const dbModule = await loadDbModule();
  dbModule?.markSignalNotified(signalId);
}

export async function logMarketingAudit(
  actionType: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const dbModule = await loadDbModule();
  dbModule?.logAudit(actionType, details);
}

export async function recordMarketingSignalFeedback(
  input: RecordMarketingSignalFeedbackInput,
): Promise<void> {
  const dbModule = await loadDbModule();
  if (!dbModule) {
    throw new Error('Marketing agent sidecar unavailable');
  }
  dbModule.recordSignalFeedback(input);
}

export async function recordMarketingFeedbackEvent(
  input: RecordMarketingFeedbackEventInput,
): Promise<void> {
  const resolvedChannels = Array.isArray(input.signal.resolvedChannels)
    ? input.signal.resolvedChannels
    : [];
  const snapshotJson = JSON.stringify({
    signalId: input.signal.id,
    tweetId: input.signal.tweetId,
    author: input.signal.author,
    content: input.signal.content,
    sourceName: input.signal.sourceName,
    alertLevel: input.signal.alertLevel,
    suggestedAction: input.signal.suggestedAction,
    pipeline: input.signal.pipeline,
    actionType: input.signal.actionType,
    resolvedChannels,
  });

  await recordMarketingSignalFeedback({
    signalId: input.signal.id,
    feedbackType: input.feedbackType,
    feedbackBy: input.feedbackBy,
    sourceName: input.signal.sourceName,
    alertLevel: input.signal.alertLevel,
    suggestedAction: input.signal.suggestedAction,
    resolvedChannels,
    tweetId: input.signal.tweetId,
    snapshotJson,
  });
  await logMarketingAudit('signal_feedback_recorded', {
    signalId: input.signal.id,
    feedbackType: input.feedbackType,
    feedbackBy: input.feedbackBy,
    sourceName: input.signal.sourceName,
    alertLevel: input.signal.alertLevel,
    suggestedAction: input.signal.suggestedAction,
    resolvedChannels,
  });
}

export async function recordMarketingEmojiReaction(
  input: RecordMarketingEmojiReactionInput,
): Promise<RecordMarketingEmojiReactionResult> {
  await logMarketingAudit('signal_emoji_reaction', {
    messageId: input.messageId,
    emoji: input.emoji,
    userId: input.userId,
    username: input.username,
    channelId: input.channelId,
  });

  return {
    confirmationMessage: `✅ ${input.username ?? 'Someone'} reacted with ${input.emoji}. Feedback recorded.`,
  };
}

function parseSignalTones(signal: MarketingSignalLike): MarketingTone[] {
  if (Array.isArray(signal.tones)) {
    return signal.tones;
  }

  if (typeof signal.tones === 'string') {
    try {
      const parsed = JSON.parse(signal.tones) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((tone): tone is MarketingTone => {
          if (!tone || typeof tone !== 'object') return false;
          const candidate = tone as Partial<MarketingTone>;
          return (
            typeof candidate.id === 'string' &&
            typeof candidate.label === 'string' &&
            typeof candidate.description === 'string'
          );
        });
      }
    } catch {}
  }

  return [];
}

function selectMarketingTone(
  signal: MarketingSignalLike,
  input: Pick<GenerateMarketingDraftRequestInput, 'toneId' | 'toneInput'>,
): { tone: MarketingTone | null; usedFallbackTone: boolean } {
  const tones = parseSignalTones(signal);
  if (tones.length === 0) {
    return { tone: null, usedFallbackTone: false };
  }

  if (input.toneId) {
    const matchedTone = tones.find((tone) => tone.id === input.toneId);
    if (matchedTone) {
      return { tone: matchedTone, usedFallbackTone: false };
    }

    return {
      tone: tones[0] ?? {
        id: input.toneId,
        label: input.toneId,
        description: '',
      },
      usedFallbackTone: true,
    };
  }

  if (input.toneInput) {
    const normalizedToneInput = input.toneInput.toLowerCase();
    const toneIndex = tones.findIndex(
      (tone) =>
        tone.label.toLowerCase().includes(normalizedToneInput) ||
        tone.id.toLowerCase().includes(normalizedToneInput),
    );
    if (toneIndex >= 0) {
      return { tone: tones[toneIndex] ?? null, usedFallbackTone: false };
    }
  }

  return { tone: tones[0] ?? null, usedFallbackTone: false };
}

function buildProcessedSignal(
  signal: MarketingSignalLike,
): MarketingProcessedSignal {
  const tones = parseSignalTones(signal);

  return {
    tweet: {
      id: signal.tweetId,
      author: signal.author,
      content: signal.content,
      url: signal.url ?? '',
      created_at: signal.createdAt,
    },
    sourceName: signal.sourceName ?? '',
    alertLevel: signal.alertLevel ?? 'none',
    reasoning: signal.judgeReasoning ?? '',
    suggestedAction: signal.suggestedAction ?? 'none',
    tones:
      tones.length > 0
        ? tones
        : [
            {
              id: signal.v5Tone ?? 'official',
              label: signal.v5Tone ?? 'Official',
              description: '',
            },
          ],
    replyAngle: signal.replyAngle ?? '',
  };
}

function normalizeMarketingSignal(
  signal: MarketingSignalLike,
): MarketingSignal {
  return {
    ...signal,
    tones: parseSignalTones(signal),
  };
}

export async function resolveMarketingSignalChannels(
  signal: MarketingSignalLike,
  configDir = resolveMarketingConfigDir(),
): Promise<string[]> {
  if (signal.resolvedChannels.length > 0) {
    return signal.resolvedChannels;
  }
  if (!signal.alertLevel) {
    return [];
  }

  const [routerModule, configModule] = await Promise.all([
    loadRouterModule(),
    loadConfigModule(),
  ]);
  if (!routerModule || !configModule) {
    return [];
  }

  const allConfigs = configModule.loadAllConfigs(configDir);
  return routerModule.resolveChannels(
    buildProcessedSignal(signal),
    allConfigs.routing,
  );
}

function isInteractiveSignal(signal: MarketingSignalLike): boolean {
  if (signal.alertLevel) {
    return ['reply_supportive', 'qrt_positioning'].includes(
      signal.suggestedAction ?? '',
    );
  }

  return ['reply', 'qrt', 'statement'].includes(signal.actionType);
}

export async function getMarketingSignalDispatches(
  limit = 20,
  configDir = resolveMarketingConfigDir(),
): Promise<MarketingSignalDispatch[]> {
  const signals = await getMarketingUnnotifiedSignals(limit);
  const dispatches: MarketingSignalDispatch[] = [];

  for (const signal of signals) {
    const targetChannels =
      signal.resolvedChannels.length > 0
        ? signal.resolvedChannels
        : signal.alertLevel
          ? await resolveMarketingSignalChannels(signal, configDir)
          : ['noise'];

    dispatches.push({
      signal,
      targetChannels,
      isInteractive: isInteractiveSignal(signal),
    });
  }

  return dispatches;
}

export async function generateMarketingDraft(
  signal: MarketingSignal,
  tone: string,
  context?: string,
  configDir = resolveMarketingConfigDir(),
): Promise<string> {
  const generatorModule = await loadGeneratorModule();
  if (!generatorModule) {
    throw new Error('Marketing agent sidecar unavailable');
  }
  generatorModule.loadGeneratorRuntimeConfig(configDir);
  return generatorModule.generateSingleToneDraft(signal, tone, context);
}

export async function generateMarketingDraftRequest(
  input: GenerateMarketingDraftRequestInput,
): Promise<GenerateMarketingDraftRequestResult> {
  const { tone, usedFallbackTone } = selectMarketingTone(input.signal, input);
  if (!tone) {
    throw new Error('No tones available for this signal.');
  }

  const draftText = await generateMarketingDraft(
    normalizeMarketingSignal(input.signal),
    tone.id,
    input.context,
    input.configDir,
  );

  return {
    tone,
    toneLabel: (tone.label || tone.id || 'Tone').trim(),
    draftText,
    usedFallbackTone,
  };
}

export async function formatMarketingFeedbackDigest(
  targetDate = new Date(),
): Promise<{ digest: MarketingFeedbackDigest; message: string } | null> {
  const feedbackModule = await loadFeedbackModule();
  if (!feedbackModule) {
    return null;
  }

  const digest = feedbackModule.generateDailyFeedbackDigest(targetDate);
  return {
    digest,
    message: feedbackModule.formatDailyFeedbackDigest(digest),
  };
}
