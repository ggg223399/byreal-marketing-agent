import type { ActionType, CollectorConfig, Pipeline, PipelineSignal } from '../types/index.js';

type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

type DiscordEmbed = {
  title: string;
  description: string;
  color: number;
  url?: string;
  fields: DiscordEmbedField[];
  footer: { text: string };
  timestamp: string;
};

type DiscordWebhookPayload = {
  content?: string;
  embeds: DiscordEmbed[];
};

export async function sendWebhook(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed (${response.status}): ${body}`);
  }
}

function pipelineLabel(pipeline: Pipeline): string {
  if (pipeline === 'mentions') return 'Mentions';
  if (pipeline === 'network') return 'Network';
  if (pipeline === 'trends') return 'Trends';
  return 'Crisis';
}

export function pipelineEmoji(pipeline: Pipeline): string {
  if (pipeline === 'mentions') return '🔵';
  if (pipeline === 'network') return '🟢';
  if (pipeline === 'trends') return '🟣';
  return '🔴';
}

export function pipelineColor(pipeline: Pipeline): number {
  if (pipeline === 'mentions') return 0x3498DB;
  if (pipeline === 'network') return 0x2ECC71;
  if (pipeline === 'trends') return 0x9B59B6;
  return 0xE74C3C;
}

export function actionTypeLabel(actionType: ActionType): string {
  if (actionType === 'reply') return 'Reply';
  if (actionType === 'qrt') return 'Quote Tweet';
  if (actionType === 'statement') return 'Statement';
  if (actionType === 'like') return 'Like';
  if (actionType === 'monitor') return 'Monitor';
  return 'Skip';
}


export function formatSignalForDiscord(signal: PipelineSignal): DiscordWebhookPayload {
  const content = signal.content.replace(/\s+/g, ' ').trim().slice(0, 280);

  return {
    embeds: [
      {
        color: pipelineColor(signal.pipeline),
        title: `${pipelineEmoji(signal.pipeline)} #${signal.id} — ${pipelineLabel(signal.pipeline)}`,
        description: content,
        url: signal.url,
        fields: [
          { name: 'Author', value: `[${signal.author}](https://x.com/${signal.author.replace(/^@/, '')})`, inline: true },
          { name: 'Pipeline', value: pipelineLabel(signal.pipeline), inline: true },
          { name: 'Action', value: actionTypeLabel(signal.actionType), inline: true },
          { name: 'Angle', value: signal.angle || 'N/A', inline: false },
          { name: 'Reason', value: signal.reason || 'N/A', inline: false },
        ],
        footer: { text: `Signal · ${new Date(signal.createdAt * 1000).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })}` },
        timestamp: new Date(signal.createdAt * 1000).toISOString(),
      },
    ],
  };
}

export interface TargetChannels {
  tier?: string;
  action?: string;
  shadow?: string;
}

export function resolveTargetChannels(signal: PipelineSignal, config: CollectorConfig): TargetChannels {
  let tier: string | undefined;
  let action: string | undefined;
  const needsReply = config.notifications.needsReplyChannel ?? 'needs-reply';
  const needsInteraction = config.notifications.needsInteractionChannel ?? 'needs-interaction';
  const tier1 = config.notifications.tier1Channel ?? 'tier1-signals';
  const tier2 = config.notifications.tier2Channel ?? 'tier2-signals';
  const tier3 = config.notifications.tier3Channel ?? 'tier3-signals';
  const ownActivity = config.notifications.ownActivityChannel ?? 'own-activity';
  const competitorIntel = config.notifications.competitorIntelChannel ?? 'competitor-intel';

  const noiseChannel = config.notifications.noiseChannel ?? 'noise';
  const isInteractive = signal.actionType === 'reply' || signal.actionType === 'qrt' || signal.actionType === 'statement';

  if (isInteractive) {
    if (signal.pipeline === 'network') {
      action = needsInteraction;
      tier = needsInteraction;
    } else {
      action = needsReply;
      tier = needsReply;
    }
    return { tier, action };
  }

  if (signal.actionType === 'skip') {
    if (signal.pipeline === 'network' && signal.accountTier === 'O') {
      return { tier: ownActivity };
    }
    return { tier: noiseChannel };
  }

  if (signal.pipeline === 'network') {
    if (signal.accountTier === 'O') tier = ownActivity;
    else if (signal.accountTier === 'S') tier = tier1;
    else if (signal.accountTier === 'A') tier = tier2;
    else if (signal.accountTier === 'B') tier = signal.actionType === 'monitor' ? competitorIntel : tier3;
    else if (signal.accountTier === 'C') tier = tier3;
    else tier = noiseChannel;
  } else if (signal.pipeline === 'trends') {
    if (signal.connection === 'direct') tier = tier1;
    else if (signal.connection === 'indirect') tier = tier2;
    else if (signal.connection === 'stretch') tier = tier3;
    else tier = noiseChannel;
  } else if (signal.pipeline === 'crisis') {
    if (signal.severity === 'critical') tier = tier1;
    else if (signal.severity === 'high') tier = tier2;
    else if (signal.severity === 'medium') tier = tier3;
    else tier = noiseChannel;
  } else if (signal.pipeline === 'mentions') {
    if (signal.actionType === 'like' || signal.actionType === 'monitor') {
      tier = needsInteraction;
    } else {
      tier = tier2;
    }
  } else {
    tier = tier3;
  }

  return { tier };
}

export function resolveChannelName(signal: PipelineSignal, config: CollectorConfig): string {
  const { tier } = resolveTargetChannels(signal, config);
  return tier ?? '';
}
