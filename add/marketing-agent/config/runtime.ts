import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_DIR = 'marketing-agent/config';
const FALLBACK_CONFIG_DIR = '../nanoclaw-marketing/marketing-agent/config';

function looksLikeConfigDir(dir: string): boolean {
  return (
    existsSync(path.join(dir, 'accounts.yaml'))
    && existsSync(path.join(dir, 'sources.yaml'))
  );
}

export function resolveMarketingConfigDir(cwd = process.cwd()): string {
  const explicit =
    process.env.MARKETING_AGENT_CONFIG_DIR ?? process.env.ENGINE_CONFIG_DIR;
  if (explicit) {
    return path.resolve(cwd, explicit);
  }

  const fallbackDir = path.resolve(cwd, FALLBACK_CONFIG_DIR);
  if (looksLikeConfigDir(fallbackDir)) {
    return fallbackDir;
  }

  const defaultDir = path.resolve(cwd, DEFAULT_CONFIG_DIR);
  if (looksLikeConfigDir(defaultDir)) {
    return defaultDir;
  }

  return defaultDir;
}
