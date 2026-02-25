import type { CollectorConfig, Signal } from '../types/index.js';

async function sendWebhook(webhookUrl: string, content: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
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

export function formatSignalForDiscord(signal: Signal): string {
  return [
    `${levelEmoji(signal.alertLevel)} **#${signal.id}** ${signal.author} | ${signal.signalClass} (${(signal.confidence * 100).toFixed(0)}%)`,
    `> ${signal.content.slice(0, 200)}`,
    signal.url ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function routeSignalNotification(signal: Signal, config: CollectorConfig): Promise<void> {
  const webhookUrl = config.notifications.discordWebhookUrl;
  if (!webhookUrl) {
    return;
  }

  const channel =
    signal.alertLevel === 'red' || signal.alertLevel === 'orange'
      ? config.notifications.urgentChannel || 'urgent-signals'
      : config.notifications.allChannel || 'all-signals';

  const content = `[#${channel}]\n${formatSignalForDiscord(signal)}`;
  await sendWebhook(webhookUrl, content);
}

export async function routeBatchNotifications(signals: Signal[], config: CollectorConfig): Promise<void> {
  for (const signal of signals) {
    await routeSignalNotification(signal, config);
  }
}
