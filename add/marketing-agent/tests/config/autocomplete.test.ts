import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGroupChoices,
  getHandleChoices,
  getKeywordChoices,
  getSourceChoices,
} from '../../config/autocomplete.js';

const ACCOUNTS_YAML = `accounts:
  core:
    - handle: solana
    - handle: toly
  top-dapps:
    - handle: JupiterExchange
    - handle: Raydium
  solana-kols:
    - handle: mert
`;

const SOURCES_YAML = `sources:
  - name: trend-keywords
    schedule: "10 * * * *"
    keywords:
      - AI agent Solana
      - DeFi AI agent
      - Solana perps
  - name: direct-mentions
    schedule: "7,37 * * * *"
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'byreal-ac-test-'));
  writeFileSync(path.join(tmpDir, 'accounts.yaml'), ACCOUNTS_YAML);
  writeFileSync(path.join(tmpDir, 'sources.yaml'), SOURCES_YAML);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getGroupChoices', () => {
  it('returns all groups when focused is empty', () => {
    const choices = getGroupChoices(tmpDir, '');
    expect(choices.map((c) => c.value)).toEqual(['core', 'top-dapps', 'solana-kols']);
  });

  it('filters by focused text', () => {
    const choices = getGroupChoices(tmpDir, 'sol');
    expect(choices.map((c) => c.value)).toEqual(['solana-kols']);
  });

  it('is case-insensitive', () => {
    const choices = getGroupChoices(tmpDir, 'CORE');
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe('core');
  });
});

describe('getHandleChoices', () => {
  it('returns handles for a group', () => {
    const choices = getHandleChoices(tmpDir, 'core', '');
    expect(choices.map((c) => c.value)).toEqual(['solana', 'toly']);
  });

  it('filters by focused text', () => {
    const choices = getHandleChoices(tmpDir, 'core', 'tol');
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe('toly');
  });

  it('returns empty for unknown group', () => {
    expect(getHandleChoices(tmpDir, 'nonexistent', '')).toEqual([]);
  });

  it('shows @ prefix in display name', () => {
    const choices = getHandleChoices(tmpDir, 'core', '');
    expect(choices[0].name).toBe('@solana');
  });
});

describe('getKeywordChoices', () => {
  it('returns all keywords when focused is empty', () => {
    const choices = getKeywordChoices(tmpDir, '');
    expect(choices).toHaveLength(3);
  });

  it('filters by focused text', () => {
    const choices = getKeywordChoices(tmpDir, 'defi');
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe('DeFi AI agent');
  });
});

describe('getSourceChoices', () => {
  it('returns all source names', () => {
    const choices = getSourceChoices(tmpDir, '');
    expect(choices.map((c) => c.value)).toEqual(['trend-keywords', 'direct-mentions']);
  });

  it('filters by focused text', () => {
    const choices = getSourceChoices(tmpDir, 'direct');
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe('direct-mentions');
  });
});
