import type {
  MarketingActionType as ActionType,
  MarketingPipeline as Pipeline,
  MarketingSignal,
  MarketingTone as ToneItem,
} from '../sidecars/marketing-agent.js';

const THREAD_SEPARATOR = '\n---\n';

export type MarketingSignalRenderInput = Omit<MarketingSignal, 'tones'> & {
  tones: ToneItem[] | string;
  imageUrl?: string;
  image_url?: string;
  image?: string;
  created_at?: string;
  sourceName?: string;
  alertLevel?: string;
  suggestedAction?: string;
  v5Tone?: string;
  replyAngle?: string;
  judgeReasoning?: string;
};

export interface ThreadDisplaySelectionInput {
  content: string;
  author?: string;
  sourceName?: string;
  suggestedAction?: string;
  replyAngle?: string;
  judgeReasoning?: string;
}

export interface ThreadDisplaySelection {
  content: string;
  isThread: boolean;
  totalPosts: number;
}

export interface MarketingCardFieldViewModel {
  name: string;
  value: string;
  inline: boolean;
}

export interface MarketingActionCardViewModel {
  color: number;
  title: string;
  url: string | null;
  description: string;
  footerText: string;
  thumbnailUrl: string;
  imageUrl?: string;
  fields: MarketingCardFieldViewModel[];
}

export interface MarketingDraftCardViewModel {
  color: number;
  title: string;
  url: string | null;
  description: string;
  footerText: string;
}

function splitThreadPosts(content: string): string[] {
  return content
    .split(THREAD_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokenizeForRelevance(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9_@#\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function scoreThreadPost(post: string, referenceTokens: Set<string>): number {
  if (referenceTokens.size === 0) {
    return 0;
  }

  const tokens = tokenizeForRelevance(post);
  let score = 0;
  for (const token of tokens) {
    if (referenceTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

export function selectDisplayContentForDiscord(
  input: ThreadDisplaySelectionInput,
): ThreadDisplaySelection {
  const posts = splitThreadPosts(input.content);
  if (posts.length <= 1) {
    return {
      content: input.content.trim(),
      isThread: false,
      totalPosts: 1,
    };
  }

  const referenceText = [
    input.author ?? '',
    input.sourceName ?? '',
    input.suggestedAction ?? '',
    input.replyAngle ?? '',
    input.judgeReasoning ?? '',
  ].join(' ');
  const referenceTokens = new Set(tokenizeForRelevance(referenceText));

  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < posts.length; i += 1) {
    const score = scoreThreadPost(posts[i], referenceTokens);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return {
    content: posts[bestIndex],
    isThread: true,
    totalPosts: posts.length,
  };
}

function titleCaseCategory(raw: string): string {
  return raw
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pipelineLabel(pipeline: Pipeline): string {
  if (pipeline === 'mentions') return 'Mentions';
  if (pipeline === 'network') return 'Network';
  if (pipeline === 'trends') return 'Trends';
  return 'Crisis';
}

function actionLabel(actionType: ActionType): string {
  if (actionType === 'reply') return 'Reply';
  if (actionType === 'qrt') return 'Quote Tweet';
  if (actionType === 'statement') return 'Statement';
  if (actionType === 'like') return 'Like';
  if (actionType === 'monitor') return 'Monitor';
  return 'Skip';
}

function pipelineColor(pipeline: Pipeline): number {
  if (pipeline === 'mentions') return 0x3498db;
  if (pipeline === 'network') return 0x2ecc71;
  if (pipeline === 'trends') return 0x9b59b6;
  return 0xe74c3c;
}

function alertLevelColor(level: string): number {
  if (level === 'red') return 0xe74c3c;
  if (level === 'orange') return 0xe67e22;
  if (level === 'yellow') return 0xf1c40f;
  return 0x95a5a6;
}

function alertLevelEmoji(level: string): string {
  if (level === 'red') return '🔴';
  if (level === 'orange') return '🟠';
  if (level === 'yellow') return '🟡';
  return '⚪';
}

function suggestedActionLabel(action: string): string {
  if (action === 'reply_supportive') return 'Reply';
  if (action === 'qrt_positioning') return 'Quote Tweet';
  if (action === 'collab_opportunity') return 'Collab Opportunity';
  if (action === 'like_only') return 'Like';
  if (action === 'explore_signal') return 'Explore';
  if (action === 'escalate_internal') return 'Escalate';
  return 'None';
}

function sourceLabel(source: string): string {
  if (source === 'ecosystem-core') return 'Ecosystem Core';
  if (source === 'explore-window') return 'Explore Window';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function formatCount(n: number | undefined): string {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTweetTime(date: Date): string {
  const nowInShanghai = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  );
  const dateInShanghai = new Date(
    date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  );
  const isToday =
    nowInShanghai.getFullYear() === dateInShanghai.getFullYear() &&
    nowInShanghai.getMonth() === dateInShanghai.getMonth() &&
    nowInShanghai.getDate() === dateInShanghai.getDate();
  const timeStr = date.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  if (isToday) return `Today at ${timeStr}`;
  const monthDay = date.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'short',
    day: 'numeric',
  });
  return `${monthDay} at ${timeStr}`;
}

function toDateFromUnknown(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      return new Date(asNum * 1000);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function getTweetCreatedAt(signal: MarketingSignalRenderInput): Date {
  if (signal.rawJson) {
    try {
      const raw = JSON.parse(signal.rawJson);
      const fromTweet = toDateFromUnknown(raw?.tweet?.created_at);
      if (fromTweet) return fromTweet;
      const fromRoot = toDateFromUnknown(raw?.created_at);
      if (fromRoot) return fromRoot;
    } catch {}
  }

  if (signal.createdAt) {
    return new Date(signal.createdAt * 1000);
  }
  if (signal.created_at) {
    return new Date(signal.created_at);
  }
  return new Date();
}

function getSignalMedia(signal: MarketingSignalRenderInput): {
  imageUrl?: string;
  authorFollowers?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
} {
  let imageUrl = signal.imageUrl || signal.image_url || signal.image;
  let authorFollowers: number | undefined;
  let likes: number | undefined;
  let retweets: number | undefined;
  let replies: number | undefined;
  let views: number | undefined;

  if (signal.rawJson) {
    try {
      const raw = JSON.parse(signal.rawJson);
      const metaImage = raw?.metadata?.imageUrl;
      if (
        !imageUrl &&
        typeof metaImage === 'string' &&
        metaImage.startsWith('http')
      ) {
        imageUrl = metaImage;
      }
      const metrics = raw?.metrics ?? {};
      const meta = raw?.metadata ?? raw?.tweet?.metadata ?? {};
      authorFollowers =
        typeof meta.authorFollowers === 'number'
          ? meta.authorFollowers
          : undefined;
      likes =
        metrics.likes ??
        (typeof meta.likes === 'number' ? meta.likes : undefined);
      retweets =
        metrics.retweets ??
        (typeof meta.retweets === 'number' ? meta.retweets : undefined);
      replies =
        metrics.replies ??
        (typeof meta.replies === 'number' ? meta.replies : undefined);
      views =
        metrics.views ??
        (typeof meta.views === 'number' ? meta.views : undefined);
    } catch {}
  }

  return {
    imageUrl,
    authorFollowers,
    likes,
    retweets,
    replies,
    views,
  };
}

export function buildMarketingActionCardViewModel(
  signal: MarketingSignalRenderInput,
): MarketingActionCardViewModel {
  const isV5 = Boolean(signal.alertLevel);
  const displaySelection = selectDisplayContentForDiscord({
    content: signal.content,
    author: signal.author,
    sourceName: signal.sourceName,
    suggestedAction: signal.suggestedAction,
    replyAngle: signal.replyAngle,
    judgeReasoning: signal.judgeReasoning,
  });
  const content = displaySelection.content.trim();
  const maxDescLen = 3200;
  const trimmedContent =
    content.length > maxDescLen ? `${content.slice(0, maxDescLen)}…` : content;
  const createdAt = getTweetCreatedAt(signal);
  const authorName = signal.author.replace(/^@/, '');
  const media = getSignalMedia(signal);

  const borderColor = isV5
    ? alertLevelColor(signal.alertLevel ?? 'none')
    : pipelineColor(signal.pipeline);
  const title = isV5
    ? `${alertLevelEmoji(signal.alertLevel ?? 'none')} @${authorName} — ${sourceLabel(signal.sourceName ?? '')}`
    : `@${authorName} - ${pipelineLabel(signal.pipeline)}`;
  const footerText = isV5
    ? `Signal #${signal.id} · ${suggestedActionLabel(signal.suggestedAction ?? '')} · ${signal.v5Tone ?? ''} • ${formatTweetTime(createdAt)}`
    : `Signal #${signal.id} · ${actionLabel(signal.actionType)} • ${formatTweetTime(createdAt)}`;
  const angle = isV5 ? (signal.replyAngle ?? '') : signal.angle || '';
  const reason = isV5 ? (signal.judgeReasoning ?? '') : signal.reason || '';
  const analysis = reason ? `${angle}\n\n_${reason}_` : angle;
  const description = signal.url
    ? `${trimmedContent}\n\n[View Tweet →](${signal.url})`
    : trimmedContent;
  const fieldSep = '─'.repeat(32);

  let accountLabel = 'Account';
  if (isV5 && signal.alertLevel) {
    accountLabel = `Alert · ${signal.alertLevel.toUpperCase()}`;
  } else if (signal.pipeline === 'network' && signal.accountTier) {
    accountLabel = `Account · Tier ${signal.accountTier}`;
  } else if (signal.pipeline === 'trends' && signal.connection) {
    accountLabel = `Account · ${titleCaseCategory(signal.connection)}`;
  } else if (signal.pipeline === 'crisis' && signal.severity) {
    accountLabel = `Account · ${titleCaseCategory(signal.severity)}`;
  }

  const followersValue =
    media.authorFollowers != null && media.authorFollowers > 0
      ? `👤 ${formatCount(media.authorFollowers)} followers`
      : '—';
  const engagementParts: string[] = [];
  if (media.views != null)
    engagementParts.push(`👁 ${formatCount(media.views)}`);
  if (media.likes != null)
    engagementParts.push(`❤️ ${formatCount(media.likes)}`);
  if (media.retweets != null) {
    engagementParts.push(`🔁 ${formatCount(media.retweets)}`);
  }
  if (media.replies != null) {
    engagementParts.push(`💬 ${formatCount(media.replies)}`);
  }
  const engagementValue =
    engagementParts.length > 0 ? engagementParts.join(' · ') : '—';

  const fields: MarketingCardFieldViewModel[] = [
    { name: fieldSep, value: '\u200B', inline: false },
    { name: accountLabel, value: followersValue, inline: true },
    { name: 'Engagement', value: engagementValue, inline: true },
  ];

  if (displaySelection.isThread) {
    fields.push({
      name: 'Format',
      value: `Thread · ${displaySelection.totalPosts} posts`,
      inline: true,
    });
  }

  if (analysis) {
    const maxAnalysisLen = 1000;
    const truncatedAnalysis =
      analysis.length > maxAnalysisLen
        ? analysis.slice(0, maxAnalysisLen - 3) + '...'
        : analysis;
    fields.push({
      name: fieldSep,
      value: truncatedAnalysis,
      inline: false,
    });
  }

  return {
    color: borderColor,
    title,
    url: signal.url || null,
    description,
    footerText,
    thumbnailUrl: `https://unavatar.io/twitter/${authorName}`,
    imageUrl: media.imageUrl,
    fields,
  };
}

export function buildMarketingDraftCardViewModel(
  signal: MarketingSignalRenderInput,
  toneLabel: string,
  draftText: string,
): MarketingDraftCardViewModel {
  const safeDraftText = draftText.replace(/```/g, "'''").trim();
  const authorName = signal.author.replace(/^@/, '');
  const charCount = safeDraftText.length;
  const charIndicator =
    charCount <= 280 ? `✅ ${charCount}/280` : `⚠️ ${charCount}/280`;
  const originalContent = signal.content.trim();
  const truncatedOriginal =
    originalContent.length > 150
      ? originalContent.slice(0, 147) + '...'
      : originalContent;
  const separator = '─'.repeat(32);

  return {
    color: 0x1da1f2,
    title: `📝 ${toneLabel}`,
    url: signal.url || null,
    description: [
      safeDraftText,
      '',
      separator,
      `💬 Re: @${authorName}`,
      `> ${truncatedOriginal.split('\n').join('\n> ')}`,
    ].join('\n'),
    footerText: `${charIndicator} · Signal #${signal.id}`,
  };
}
