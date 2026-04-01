import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readYamlSafe, writeYamlSafe } from '../../config/yaml-editor.js';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'byreal-yaml-test-'));
}

describe('readYamlSafe', () => {
  it('reads and parses a YAML file', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.yaml');
    writeFileSync(file, 'accounts:\n  core:\n    - handle: solana\n');
    const result = readYamlSafe(file);
    expect(result.accounts.core[0].handle).toBe('solana');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws on missing file', () => {
    expect(() => readYamlSafe('/nonexistent.yaml')).toThrow();
  });
});

describe('writeYamlSafe', () => {
  it('writes YAML and creates .bak backup', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.yaml');
    writeFileSync(file, 'old: value\n');
    writeYamlSafe(file, { new: 'value' });
    expect(readFileSync(file, 'utf-8')).toContain('new: value');
    expect(existsSync(file + '.bak')).toBe(true);
    expect(readFileSync(file + '.bak', 'utf-8')).toContain('old: value');
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves original content in backup', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.yaml');
    const original = '# Important comment\nkey: value\n';
    writeFileSync(file, original);
    writeYamlSafe(file, { key: 'new' });
    expect(readFileSync(file + '.bak', 'utf-8')).toBe(original);
    rmSync(dir, { recursive: true, force: true });
  });
});
