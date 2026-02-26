import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/loader.js';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'byreal-config-test-'));
}

const previousCwd = process.cwd();

afterEach(() => {
  process.chdir(previousCwd);
  delete process.env.DATA_SOURCE_API_KEY;
});

describe('config loader', () => {
  it('loads explicit config path', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'a.yaml');
    writeFileSync(file, 'dataSource:\n  type: mock\n');
    const config = loadConfig(file);
    expect(config.dataSource.type).toBe('mock');
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses config.yaml when present in cwd', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'config.yaml'), 'dataSource:\n  type: twitterapi_io\n');
    process.chdir(dir);
    const config = loadConfig();
    expect(config.dataSource.type).toBe('twitterapi_io');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to config.yaml.example when config.yaml missing', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'config.yaml.example'), 'dataSource:\n  type: mock\n');
    process.chdir(dir);
    const config = loadConfig();
    expect(config.dataSource.type).toBe('mock');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when no config files exist', () => {
    const dir = makeTmpDir();
    process.chdir(dir);
    expect(() => loadConfig()).toThrow('Missing config.yaml and config.yaml.example');
    rmSync(dir, { recursive: true, force: true });
  });

  it('injects DATA_SOURCE_API_KEY from env', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'c.yaml');
    writeFileSync(file, 'dataSource:\n  type: mock\n  apiKey: old\n');
    process.env.DATA_SOURCE_API_KEY = 'new-key';
    const config = loadConfig(file);
    expect(config.dataSource.apiKey).toBe('new-key');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps yaml apiKey if env not set', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'c.yaml');
    writeFileSync(file, 'dataSource:\n  type: mock\n  apiKey: old\n');
    const config = loadConfig(file);
    expect(config.dataSource.apiKey).toBe('old');
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies defaults for missing sections', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'd.yaml');
    writeFileSync(file, '{}\n');
    const config = loadConfig(file);
    expect(config.monitoring.pollingIntervalMinutes).toBe(30);
    expect(config.governance.maxRepliesPerHour).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads monitoring arrays', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'm.yaml');
    writeFileSync(file, 'monitoring:\n  accountsTier1: ["@a"]\n  accountsPartners: ["@b"]\n  keywords: ["k"]\n');
    const config = loadConfig(file);
    expect(config.monitoring.accountsTier1).toEqual(['@a']);
    expect(config.monitoring.accountsPartners).toEqual(['@b']);
    expect(config.monitoring.keywords).toEqual(['k']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads classification model and temperature', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'cls.yaml');
    writeFileSync(file, 'classification:\n  model: claude-sonnet\n  temperature: 0.2\n');
    const config = loadConfig(file);
    expect(config.classification?.model).toBe('claude-sonnet');
    expect(config.classification?.temperature).toBe(0.2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads notification channel names', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'n.yaml');
    writeFileSync(file, 'notifications:\n  risk_channel: "my-risk"\n  opportunities_channel: "my-opp"\n  ecosystem_channel: "my-eco"\n');
    const config = loadConfig(file);
    expect(config.notifications.riskChannel).toBe('my-risk');
    expect(config.notifications.opportunitiesChannel).toBe('my-opp');
    expect(config.notifications.ecosystemChannel).toBe('my-eco');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads governance lists', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'g.yaml');
    writeFileSync(file, 'governance:\n  blacklist: ["@spam"]\n  riskKeywords: ["hack"]\n');
    const config = loadConfig(file);
    expect(config.governance.blacklist).toEqual(['@spam']);
    expect(config.governance.riskKeywords).toEqual(['hack']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves digest settings', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'd2.yaml');
    writeFileSync(file, 'notifications:\n  digestTime: "08:30"\n  digestTimezone: UTC\n');
    const config = loadConfig(file);
    expect(config.notifications.digestTime).toBe('08:30');
    expect(config.notifications.digestTimezone).toBe('UTC');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns default channel names and empty digest webhook when missing', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'z.yaml');
    writeFileSync(file, '{}');
    const config = loadConfig(file);
    expect(config.notifications.riskChannel).toBe('risk-alerts');
    expect(config.notifications.opportunitiesChannel).toBe('opportunities');
    expect(config.notifications.ecosystemChannel).toBe('ecosystem-feed');
    expect(config.notifications.digestWebhookUrl).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns default classification values when missing', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'z2.yaml');
    writeFileSync(file, '{}');
    const config = loadConfig(file);
    expect(config.classification?.model).toBe('claude-3-5-haiku-20241022');
    expect(config.classification?.temperature).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns default governance caps when missing', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'z3.yaml');
    writeFileSync(file, '{}');
    const config = loadConfig(file);
    expect(config.governance.maxRepliesPerHour).toBe(5);
    expect(config.governance.maxRepliesPerDay).toBe(20);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns default polling interval when missing', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'z4.yaml');
    writeFileSync(file, '{}');
    const config = loadConfig(file);
    expect(config.monitoring.pollingIntervalMinutes).toBe(30);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps configured data source type', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'z5.yaml');
    writeFileSync(file, 'dataSource:\n  type: xpoz\n');
    const config = loadConfig(file);
    expect(config.dataSource.type).toBe('xpoz');
    rmSync(dir, { recursive: true, force: true });
  });
});
