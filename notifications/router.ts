import { SIGNAL_CATEGORIES } from '../types/index.js';
import type { CollectorConfig, Signal } from '../types/index.js';

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

async function sendWebhook(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void> {
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

function levelEmoji(level: Signal['alertLevel']): string {
  if (level === 'red') return '🔴';
  if (level === 'orange') return '🟠';
  if (level === 'yellow') return '🟡';
  return '⚪';
}

function levelColor(level: Signal['alertLevel']): number {
  if (level === 'red') return 0xff0000;
  if (level === 'orange') return 0xff8c00;
  if (level === 'yellow') return 0xffd700;
  return 0x95a5a6;
}

function toTitleCase(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sentimentLabel(sentiment: Signal['sentiment']): string {
  if (sentiment === 'positive') return '📈 Positive';
  if (sentiment === 'negative') return '📉 Negative';
  return '➡️ Neutral';
}

function priorityLabel(priority: number): string {
  if (priority <= 1) return '🔴 P1';
  if (priority === 2) return '🟠 P2';
  if (priority === 3) return '🟡 P3';
  if (priority === 4) return '⚪ P4';
  return '⚪ P5';
}

function riskLabel(risk: Signal['riskLevel']): string {
  if (risk === 'high') return '🔴 High';
  if (risk === 'medium') return '🟠 Medium';
  return '🟢 Low';
}

function actionLabel(action: Signal['suggestedAction']): string {
  if (action === 'qrt_positioning') return '📢 **Quote Tweet**';
  if (action === 'reply_supportive') return '💬 **Reply** · Supportive';
  if (action === 'like_only') return '👍 **Like Only**';
  if (action === 'monitor') return '👀 **Monitor**';
  return '🚨 **Escalate** · Internal';
}


export function formatSignalForDiscord(signal: Signal): DiscordWebhookPayload {
  const categoryName = SIGNAL_CATEGORIES[signal.category] ?? 'unknown_category';
  const titleCategory = toTitleCase(categoryName);
  const content = signal.content.replace(/\s+/g, ' ').trim().slice(0, 280);

  return {
    embeds: [
      {
        color: levelColor(signal.alertLevel),
        title: `${levelEmoji(signal.alertLevel)} #${signal.id} — ${titleCategory}`,
        description: content,
        url: signal.url,
        fields: [
          { name: 'Author', value: `[@${signal.author}](https://x.com/${signal.author})`, inline: true },
          { name: 'Category', value: `${signal.category} — ${titleCategory}`, inline: true },
          { name: 'Confidence', value: `${signal.confidence}%`, inline: true },
          { name: 'Sentiment', value: sentimentLabel(signal.sentiment), inline: true },
          { name: 'Priority', value: priorityLabel(signal.priority), inline: true },
          { name: 'Risk', value: riskLabel(signal.riskLevel), inline: true },
          { name: 'Action', value: actionLabel(signal.suggestedAction), inline: false },
        ],
        footer: { text: `Signal · ${new Date(signal.createdAt * 1000).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })}` },
        timestamp: new Date(signal.createdAt * 1000).toISOString(),
      },
    ],
  };
}

export interface TargetChannels {
  tier: string;
  action?: string;
}

export function resolveTargetChannels(signal: Signal, config: CollectorConfig): TargetChannels {
  const tier1 = config.notifications.tier1Channel ?? 'tier1-signals';
  const tier2 = config.notifications.tier2Channel ?? 'tier2-signals';
  const tier3 = config.notifications.tier3Channel ?? 'tier3-signals';
  const noise = config.notifications.noiseChannel ?? 'noise';
  
  let tier: string;
  if (signal.alertLevel === 'red') {
    tier = tier1;
  } else if (signal.alertLevel === 'orange') {
    tier = tier2;
  } else if (signal.alertLevel === 'yellow') {
    tier = tier3;
  } else {
    tier = noise;
  }
  
  let action: string | undefined;
  const needsReply = config.notifications.needsReplyChannel ?? 'needs-reply';
  const needsInteraction = config.notifications.needsInteractionChannel ?? 'needs-interaction';
  
  if (signal.suggestedAction === 'reply_supportive' || signal.suggestedAction === 'qrt_positioning') {
    action = needsReply;
  } else if (signal.suggestedAction === 'like_only' || signal.suggestedAction === 'escalate_internal') {
    action = needsInteraction;
  }
  
  return { tier, action };
}

export function resolveChannelName(signal: Signal, config: CollectorConfig): string {
  const { tier } = resolveTargetChannels(signal, config);
  return tier;
}
