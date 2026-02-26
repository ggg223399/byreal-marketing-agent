import { loadConfig } from '../config/loader.js';
import { formatDailyDigest, generateDailyDigest } from './generate.js';

async function postDigestIfConfigured(content: string, webhookUrl?: string): Promise<void> {
  if (!webhookUrl) {
    return;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to post digest to Discord (${response.status}): ${body}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const digest = generateDailyDigest(new Date());
  const content = formatDailyDigest(digest);

  console.log(content);
  await postDigestIfConfigured(content, config.notifications.digestWebhookUrl);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Digest failed: ${message}`);
  process.exit(1);
});
