import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMarketingConfigDir } from '../../config/runtime.js';

let tmpRoot: string | null = null;

function makeConfigDir(baseDir: string, relativeDir: string): string {
  const dir = path.join(baseDir, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'accounts.yaml'), 'accounts:\n  core: []\n');
  writeFileSync(path.join(dir, 'sources.yaml'), 'sources: []\n');
  return dir;
}

afterEach(() => {
  delete process.env.MARKETING_AGENT_CONFIG_DIR;
  delete process.env.ENGINE_CONFIG_DIR;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe('resolveMarketingConfigDir', () => {
  it('prefers explicit MARKETING_AGENT_CONFIG_DIR', () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'marketing-runtime-'));
    const dir = makeConfigDir(tmpRoot, 'custom-config');
    process.env.MARKETING_AGENT_CONFIG_DIR = dir;

    expect(resolveMarketingConfigDir(tmpRoot)).toBe(dir);
  });

  it('falls back to sibling nanoclaw-marketing config when local config is absent', () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'marketing-runtime-'));
    const fallbackDir = makeConfigDir(tmpRoot, '../nanoclaw-marketing/marketing-agent/config');

    expect(resolveMarketingConfigDir(tmpRoot)).toBe(path.resolve(fallbackDir));
  });
});
