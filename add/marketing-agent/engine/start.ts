import { createEngine } from './index.js';

console.log('[engine-start] Starting v5 signal pipeline engine');

const engine = createEngine({
  configDir: process.env.ENGINE_CONFIG_DIR ?? 'marketing-agent/config',
  model: process.env.ENGINE_MODEL ?? 'claude-haiku-4-5-20250514',
  maxTweetsPerQuery: parseInt(process.env.ENGINE_MAX_TWEETS ?? '5', 10),
  onSignalRouted: (signal, channels) => {
    console.log(
      `[engine] Routed: @${signal.tweet.author} [${signal.alertLevel}/${signal.suggestedAction}] -> ${channels.join(', ')}`,
    );
  },
});

engine.start();

process.on('SIGINT', () => {
  console.log('[engine-start] SIGINT received, stopping...');
  engine.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[engine-start] SIGTERM received, stopping...');
  engine.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('[engine-start] Unhandled rejection:', reason);
});
