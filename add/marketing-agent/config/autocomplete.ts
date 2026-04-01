import path from 'node:path';
import { readYamlSafe } from './yaml-editor.js';
import { resolveMarketingConfigDir } from './runtime.js';

export interface AutocompleteChoice {
  name: string;
  value: string;
}

function resolveConfigDir(dir?: string): string {
  return dir ?? resolveMarketingConfigDir();
}

function safeRead(filePath: string): any {
  try {
    return readYamlSafe(filePath);
  } catch {
    return null;
  }
}

export function getGroupChoices(dir: string | undefined, focused: string): AutocompleteChoice[] {
  const data = safeRead(path.join(resolveConfigDir(dir), 'accounts.yaml'));
  if (!data?.accounts) return [];
  const groups = Object.keys(data.accounts);
  const lower = focused.toLowerCase();
  return groups
    .filter((g) => g.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((g) => ({ name: g, value: g }));
}

export function getHandleChoices(dir: string | undefined, group: string, focused: string): AutocompleteChoice[] {
  const data = safeRead(path.join(resolveConfigDir(dir), 'accounts.yaml'));
  if (!data?.accounts?.[group]) return [];
  const handles: string[] = data.accounts[group].map((e: any) => e.handle);
  const lower = focused.toLowerCase();
  return handles
    .filter((h) => h.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((h) => ({ name: `@${h}`, value: h }));
}

export function getKeywordChoices(dir: string | undefined, focused: string): AutocompleteChoice[] {
  const data = safeRead(path.join(resolveConfigDir(dir), 'sources.yaml'));
  if (!data?.sources) return [];
  const source = data.sources.find((s: any) => s.name === 'trend-keywords');
  if (!source?.keywords) return [];
  const lower = focused.toLowerCase();
  return (source.keywords as string[])
    .filter((k) => k.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((k) => ({ name: k, value: k }));
}

export function getSourceChoices(dir: string | undefined, focused: string): AutocompleteChoice[] {
  const data = safeRead(path.join(resolveConfigDir(dir), 'sources.yaml'));
  if (!data?.sources) return [];
  const lower = focused.toLowerCase();
  return (data.sources as any[])
    .map((s) => s.name as string)
    .filter((n) => n.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((n) => ({ name: n, value: n }));
}
