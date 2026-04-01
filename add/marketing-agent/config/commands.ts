import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import path from 'node:path';
import { readYamlSafe, writeYamlSafe } from './yaml-editor.js';
import { resolveMarketingConfigDir } from './runtime.js';
import {
  loadJudgeConfig,
  loadReactorConfig,
  loadRoutingConfig,
  loadSourcesConfig,
} from '../engine/config-loader.js';

export interface ConfigCommandResult {
  success: boolean;
  message: string;
}

export interface GovernanceConfig {
  admin_user_ids: string[];
  admin_role_ids: string[];
  allowed_user_ids: string[];
  allowed_role_ids: string[];
  allowed_channel_ids: string[];
}

const EMPTY_GOVERNANCE: GovernanceConfig = {
  admin_user_ids: [],
  admin_role_ids: [],
  allowed_user_ids: [],
  allowed_role_ids: [],
  allowed_channel_ids: [],
};

function configDir(dir?: string): string {
  return dir ?? resolveMarketingConfigDir();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function readGovernance(dir: string): GovernanceConfig {
  const filePath = path.join(dir, 'governance.yaml');
  const data = readYamlSafe(filePath);
  const permissions = data?.config_permissions ?? {};

  return {
    admin_user_ids: uniqueSorted(Array.isArray(permissions.admin_user_ids) ? permissions.admin_user_ids : []),
    admin_role_ids: uniqueSorted(Array.isArray(permissions.admin_role_ids) ? permissions.admin_role_ids : []),
    allowed_user_ids: uniqueSorted(Array.isArray(permissions.allowed_user_ids) ? permissions.allowed_user_ids : []),
    allowed_role_ids: uniqueSorted(Array.isArray(permissions.allowed_role_ids) ? permissions.allowed_role_ids : []),
    allowed_channel_ids: uniqueSorted(Array.isArray(permissions.allowed_channel_ids) ? permissions.allowed_channel_ids : []),
  };
}

function writeGovernance(dir: string, governance: GovernanceConfig): void {
  writeYamlSafe(path.join(dir, 'governance.yaml'), {
    config_permissions: {
      admin_user_ids: uniqueSorted(governance.admin_user_ids),
      admin_role_ids: uniqueSorted(governance.admin_role_ids),
      allowed_user_ids: uniqueSorted(governance.allowed_user_ids),
      allowed_role_ids: uniqueSorted(governance.allowed_role_ids),
      allowed_channel_ids: uniqueSorted(governance.allowed_channel_ids),
    },
  });
}

function addId(list: string[], value: string): boolean {
  const normalized = value.trim();
  if (!normalized || list.includes(normalized)) {
    return false;
  }
  list.push(normalized);
  return true;
}

function removeId(list: string[], value: string): boolean {
  const normalized = value.trim();
  const index = list.indexOf(normalized);
  if (index === -1) {
    return false;
  }
  list.splice(index, 1);
  return true;
}

// ─── Accounts ───

interface AccountEntry {
  handle: string;
  notes?: string;
}

function readAccounts(dir: string): Record<string, AccountEntry[]> {
  const data = readYamlSafe(path.join(dir, 'accounts.yaml'));
  return data?.accounts ?? {};
}

function writeAccounts(dir: string, accounts: Record<string, AccountEntry[]>): void {
  writeYamlSafe(path.join(dir, 'accounts.yaml'), { accounts });
}

export function handleAccountsList(dir?: string, group?: string): ConfigCommandResult {
  const accounts = readAccounts(configDir(dir));
  if (group) {
    const entries = accounts[group];
    if (!entries) {
      const groups = Object.keys(accounts).join(', ');
      return { success: false, message: `Group \`${group}\` not found. Available: ${groups}` };
    }
    const handles = entries.map((e) => `\`${e.handle}\``).join(', ');
    return { success: true, message: `**${group}** (${entries.length}): ${handles}` };
  }
  const lines = Object.entries(accounts).map(
    ([g, entries]) => `**${g}** (${entries.length}): ${entries.map((e) => `\`${e.handle}\``).join(', ')}`,
  );
  return { success: true, message: lines.join('\n') };
}

export function handleAccountsAdd(dir: string | undefined, group: string, handle: string, userId: string): ConfigCommandResult {
  const d = configDir(dir);
  const accounts = readAccounts(d);
  const normalized = handle.replace(/^@/, '');
  if (!accounts[group]) {
    return { success: false, message: `Group \`${group}\` not found. Available: ${Object.keys(accounts).join(', ')}` };
  }
  if (accounts[group].some((e) => e.handle.toLowerCase() === normalized.toLowerCase())) {
    return { success: false, message: `\`${normalized}\` already exists in \`${group}\`.` };
  }
  accounts[group].push({ handle: normalized });
  writeAccounts(d, accounts);
  return { success: true, message: `Added \`@${normalized}\` to **${group}** (total: ${accounts[group].length}).` };
}

export function handleAccountsRemove(dir: string | undefined, group: string, handle: string, userId: string): ConfigCommandResult {
  const d = configDir(dir);
  const accounts = readAccounts(d);
  const normalized = handle.replace(/^@/, '');
  if (!accounts[group]) {
    return { success: false, message: `Group \`${group}\` not found.` };
  }
  const idx = accounts[group].findIndex((e) => e.handle.toLowerCase() === normalized.toLowerCase());
  if (idx === -1) {
    return { success: false, message: `\`${normalized}\` not found in \`${group}\`.` };
  }
  accounts[group].splice(idx, 1);
  writeAccounts(d, accounts);
  return { success: true, message: `Removed \`@${normalized}\` from **${group}** (remaining: ${accounts[group].length}).` };
}

// ─── Keywords (trend-keywords source in sources.yaml) ───

interface SourceEntry {
  name: string;
  keywords?: string[];
  schedule?: string;
  max_tweets?: number;
  prompt?: string;
  [key: string]: unknown;
}

function readSources(dir: string): { sources: SourceEntry[] } {
  return readYamlSafe(path.join(dir, 'sources.yaml'));
}

function writeSources(dir: string, data: { sources: SourceEntry[] }): void {
  writeYamlSafe(path.join(dir, 'sources.yaml'), data);
}

function findTrendKeywordsSource(sources: SourceEntry[]): SourceEntry | undefined {
  return sources.find((s) => s.name === 'trend-keywords');
}

export function handleKeywordsList(dir?: string): ConfigCommandResult {
  const data = readSources(configDir(dir));
  const source = findTrendKeywordsSource(data.sources);
  if (!source?.keywords?.length) {
    return { success: true, message: 'No keywords configured in trend-keywords source.' };
  }
  const formatted = source.keywords.map((k) => `\`${k}\``).join(', ');
  return { success: true, message: `**Trend Keywords** (${source.keywords.length}): ${formatted}` };
}

export function handleKeywordsAdd(dir: string | undefined, keyword: string, userId: string): ConfigCommandResult {
  const d = configDir(dir);
  const data = readSources(d);
  const source = findTrendKeywordsSource(data.sources);
  if (!source) {
    return { success: false, message: 'No `trend-keywords` source found in sources.yaml.' };
  }
  if (!source.keywords) source.keywords = [];
  if (source.keywords.includes(keyword)) {
    return { success: false, message: `\`${keyword}\` already exists.` };
  }
  source.keywords.push(keyword);
  writeSources(d, data);
  return { success: true, message: `Added \`${keyword}\` to trend keywords (total: ${source.keywords.length}).` };
}

export function handleKeywordsRemove(dir: string | undefined, keyword: string, userId: string): ConfigCommandResult {
  const d = configDir(dir);
  const data = readSources(d);
  const source = findTrendKeywordsSource(data.sources);
  if (!source?.keywords) {
    return { success: false, message: 'No keywords to remove.' };
  }
  const idx = source.keywords.indexOf(keyword);
  if (idx === -1) {
    return { success: false, message: `\`${keyword}\` not found.` };
  }
  source.keywords.splice(idx, 1);
  writeSources(d, data);
  return { success: true, message: `Removed \`${keyword}\` (remaining: ${source.keywords.length}).` };
}

// ─── Sources ───

export function handleSourcesList(dir?: string): ConfigCommandResult {
  const data = readSources(configDir(dir));
  const lines = data.sources.map((s) => {
    const kw = s.keywords ? ` | ${s.keywords.length} keywords` : '';
    return `**${s.name}** — \`${s.schedule}\` | max ${s.max_tweets ?? '?'} tweets${kw}`;
  });
  return { success: true, message: `**Sources** (${data.sources.length}):\n${lines.join('\n')}` };
}

export function handleSourceSetMaxTweets(dir: string | undefined, sourceName: string, value: number, userId: string): ConfigCommandResult {
  if (!Number.isFinite(value) || value < 1 || value > 20) {
    return { success: false, message: 'max_tweets must be 1-20.' };
  }
  const d = configDir(dir);
  const data = readSources(d);
  const source = data.sources.find((s) => s.name === sourceName);
  if (!source) {
    return { success: false, message: `Source \`${sourceName}\` not found.` };
  }
  const old = source.max_tweets;
  source.max_tweets = value;
  writeSources(d, data);
  return { success: true, message: `**${sourceName}** max_tweets: ${old} → ${value}` };
}

// ─── Prompt Editing ───

export type PromptTarget = 'source' | 'judge' | 'reactor' | 'brand-context';
export type EditableYamlTarget = 'accounts' | 'sources' | 'judge' | 'reactor' | 'routing';
export type EditableConfigFileTarget = EditableYamlTarget | 'brand-context';
export type EditableYamlSectionTarget = 'sources';

function truncateForDiscord(value: string, limit = 1500): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}\n...`;
}

function readBrandContext(dir: string): string {
  const filePath = path.join(dir, '..', 'prompts', 'brand_context.md');
  if (!existsSync(filePath)) {
    throw new Error(`Brand context file not found: ${filePath}`);
  }
  return readFileSync(filePath, 'utf-8');
}

function writeBrandContext(dir: string, content: string): void {
  const filePath = path.join(dir, '..', 'prompts', 'brand_context.md');
  if (existsSync(filePath)) {
    copyFileSync(filePath, filePath + '.bak');
  }
  writeFileSync(filePath, `${content.trim()}\n`, 'utf-8');
}

export function getEditableYamlFileName(target: EditableYamlTarget): string {
  return `${target}.yaml`;
}

function yamlFilePath(dir: string, target: EditableYamlTarget): string {
  return path.join(dir, getEditableYamlFileName(target));
}

export function getEditableConfigFileName(target: EditableConfigFileTarget): string {
  return target === 'brand-context' ? 'brand_context.md' : getEditableYamlFileName(target);
}

function editableConfigFilePath(dir: string, target: EditableConfigFileTarget): string {
  return target === 'brand-context'
    ? path.join(dir, '..', 'prompts', 'brand_context.md')
    : yamlFilePath(dir, target);
}

function validateEditableYamlFile(
  dir: string,
  target: EditableYamlTarget,
  filePath: string,
): void {
  switch (target) {
    case 'accounts':
      readAccounts(dir);
      return;
    case 'sources':
      loadSourcesConfig(filePath);
      return;
    case 'judge':
      loadJudgeConfig(filePath);
      return;
    case 'reactor':
      loadReactorConfig(filePath);
      return;
    case 'routing':
      loadRoutingConfig(filePath);
      return;
  }
}

function validateEditableYamlContent(target: EditableYamlTarget, content: string): void {
  try {
    parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${getEditableYamlFileName(target)} YAML parse failed: ${message}`);
  }
}

function validateEditableConfigFileContent(
  dir: string,
  target: EditableConfigFileTarget,
  filePath: string,
  content: string,
): void {
  if (target === 'brand-context') {
    if (!content.trim()) {
      throw new Error('brand_context.md cannot be empty.');
    }
    return;
  }

  validateEditableYamlContent(target, content);
  validateEditableYamlFile(dir, target, filePath);
}

export function getEditableYamlContent(
  dir: string | undefined,
  target: EditableYamlTarget,
): string {
  const d = configDir(dir);
  const filePath = yamlFilePath(d, target);
  if (!existsSync(filePath)) {
    throw new Error(`${getEditableYamlFileName(target)} not found.`);
  }
  return readFileSync(filePath, 'utf-8');
}

export function getEditableConfigFileContent(
  dir: string | undefined,
  target: EditableConfigFileTarget,
): string {
  if (target === 'brand-context') {
    return readBrandContext(configDir(dir));
  }
  return getEditableYamlContent(dir, target);
}

export function handleEditableYamlView(
  dir: string | undefined,
  target: EditableYamlTarget,
): ConfigCommandResult {
  try {
    const content = getEditableYamlContent(dir, target);
    return {
      success: true,
      message: `**${getEditableYamlFileName(target)}**\n\`\`\`yaml\n${truncateForDiscord(content)}\n\`\`\``,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
}

export function handleEditableConfigFileView(
  dir: string | undefined,
  target: EditableConfigFileTarget,
): ConfigCommandResult {
  try {
    const content = getEditableConfigFileContent(dir, target);
    const fileName = getEditableConfigFileName(target);
    const fence = target === 'brand-context' ? 'md' : 'yaml';
    return {
      success: true,
      message: `**${fileName}**\n\`\`\`${fence}\n${truncateForDiscord(content)}\n\`\`\``,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
}

export function handleEditableYamlSet(
  dir: string | undefined,
  target: EditableYamlTarget,
  content: string,
  userId: string,
): ConfigCommandResult {
  const d = configDir(dir);
  const filePath = yamlFilePath(d, target);
  const normalized = content.trim();

  if (!normalized) {
    return { success: false, message: `${getEditableYamlFileName(target)} cannot be empty.` };
  }

  if (!existsSync(filePath)) {
    return { success: false, message: `${getEditableYamlFileName(target)} not found.` };
  }

  const original = readFileSync(filePath, 'utf-8');
  const next = `${normalized}\n`;

  try {
    validateEditableYamlContent(target, next);
    writeFileSync(filePath, next, 'utf-8');
    validateEditableYamlFile(d, target, filePath);
  } catch (error) {
    writeFileSync(filePath, original, 'utf-8');
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Validation failed for **${getEditableYamlFileName(target)}**: ${message}`,
    };
  }

  copyFileSync(filePath, `${filePath}.bak`);
  writeFileSync(`${filePath}.bak`, original, 'utf-8');

  return {
    success: true,
    message: `Updated **${getEditableYamlFileName(target)}** (${next.length} chars). Backup saved to \`${getEditableYamlFileName(target)}.bak\`. Hot reload will apply on the next run.`,
  };
}

export function handleEditableConfigFileSet(
  dir: string | undefined,
  target: EditableConfigFileTarget,
  content: string,
  userId: string,
): ConfigCommandResult {
  if (target !== 'brand-context') {
    return handleEditableYamlSet(dir, target, content, userId);
  }

  const d = configDir(dir);
  const filePath = editableConfigFilePath(d, target);
  const normalized = content.trim();

  if (!normalized) {
    return { success: false, message: 'brand_context.md cannot be empty.' };
  }

  if (!existsSync(filePath)) {
    return { success: false, message: 'brand_context.md not found.' };
  }

  const original = readFileSync(filePath, 'utf-8');
  const next = `${normalized}\n`;

  try {
    validateEditableConfigFileContent(d, target, filePath, next);
    writeFileSync(filePath, next, 'utf-8');
  } catch (error) {
    writeFileSync(filePath, original, 'utf-8');
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Validation failed for **brand_context.md**: ${message}`,
    };
  }

  writeFileSync(`${filePath}.bak`, original, 'utf-8');
  return {
    success: true,
    message: 'Updated **brand_context.md**. Backup saved to `brand_context.md.bak`. Hot reload will apply on the next run.',
  };
}

export function handleEditableYamlRollback(
  dir: string | undefined,
  target: EditableYamlTarget,
): ConfigCommandResult {
  const d = configDir(dir);
  const filePath = yamlFilePath(d, target);
  const backupPath = `${filePath}.bak`;

  if (!existsSync(filePath)) {
    return { success: false, message: `${getEditableYamlFileName(target)} not found.` };
  }
  if (!existsSync(backupPath)) {
    return { success: false, message: `No backup found for \`${getEditableYamlFileName(target)}\`.` };
  }

  const current = readFileSync(filePath, 'utf-8');
  const backup = readFileSync(backupPath, 'utf-8');

  try {
    validateEditableYamlContent(target, backup);
    writeFileSync(filePath, backup, 'utf-8');
    validateEditableYamlFile(d, target, filePath);
  } catch (error) {
    writeFileSync(filePath, current, 'utf-8');
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Rollback failed for **${getEditableYamlFileName(target)}**: ${message}`,
    };
  }

  writeFileSync(backupPath, current, 'utf-8');
  return {
    success: true,
    message: `Rolled back **${getEditableYamlFileName(target)}** using the latest backup. Previous current version was preserved in \`${getEditableYamlFileName(target)}.bak\`.`,
  };
}

export function handleEditableConfigFileRollback(
  dir: string | undefined,
  target: EditableConfigFileTarget,
): ConfigCommandResult {
  if (target !== 'brand-context') {
    return handleEditableYamlRollback(dir, target);
  }

  const d = configDir(dir);
  const filePath = editableConfigFilePath(d, target);
  const backupPath = `${filePath}.bak`;

  if (!existsSync(filePath)) {
    return { success: false, message: 'brand_context.md not found.' };
  }
  if (!existsSync(backupPath)) {
    return { success: false, message: 'No backup found for `brand_context.md`.' };
  }

  const current = readFileSync(filePath, 'utf-8');
  const backup = readFileSync(backupPath, 'utf-8');

  try {
    validateEditableConfigFileContent(d, target, filePath, backup);
    writeFileSync(filePath, backup, 'utf-8');
  } catch (error) {
    writeFileSync(filePath, current, 'utf-8');
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Rollback failed for **brand_context.md**: ${message}`,
    };
  }

  writeFileSync(backupPath, current, 'utf-8');
  return {
    success: true,
    message: 'Rolled back **brand_context.md** using the latest backup. Previous current version was preserved in `brand_context.md.bak`.',
  };
}

export function getEditableYamlSectionChoices(
  dir: string | undefined,
  target: EditableYamlSectionTarget,
): Array<{ label: string; value: string }> {
  const d = configDir(dir);
  if (target !== 'sources') {
    return [];
  }

  const data = readSources(d);
  return data.sources.map((source) => ({
    label: source.name,
    value: source.name,
  }));
}

export function getEditableYamlSectionContent(
  dir: string | undefined,
  target: EditableYamlSectionTarget,
  sectionId: string,
): string {
  const d = configDir(dir);
  if (target !== 'sources') {
    throw new Error(`Unsupported YAML section target: ${target}`);
  }

  const data = readSources(d);
  const source = findSource(data, sectionId);
  if (!source) {
    throw new Error(`Source \`${sectionId}\` not found.`);
  }

  return stringifyYaml(source, { lineWidth: 120 }).trim();
}

export function handleEditableYamlSectionSet(
  dir: string | undefined,
  target: EditableYamlSectionTarget,
  sectionId: string,
  content: string,
  userId: string,
): ConfigCommandResult {
  const d = configDir(dir);
  const normalized = content.trim();

  if (!normalized) {
    return { success: false, message: 'YAML section cannot be empty.' };
  }

  if (target !== 'sources') {
    return { success: false, message: `Unsupported YAML section target: ${target}` };
  }

  let nextSource: SourceEntry;
  try {
    const parsed = parseYaml(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { success: false, message: 'Source entry must be a YAML object.' };
    }
    nextSource = parsed as SourceEntry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Validation failed for source entry: ${message}` };
  }

  const filePath = yamlFilePath(d, 'sources');
  const original = readFileSync(filePath, 'utf-8');
  const data = readSources(d);
  const index = data.sources.findIndex((source) => source.name === sectionId);
  if (index === -1) {
    return { success: false, message: `Source \`${sectionId}\` not found.` };
  }

  data.sources[index] = nextSource;

  try {
    writeSources(d, data);
    validateEditableYamlFile(d, 'sources', filePath);
  } catch (error) {
    writeFileSync(filePath, original, 'utf-8');
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Validation failed for **sources.yaml**: ${message}`,
    };
  }

  return {
    success: true,
    message: `Updated source entry **${sectionId}** in **sources.yaml**. Backup saved to \`sources.yaml.bak\`. Hot reload will apply on the next run.`,
  };
}

function findSource(data: { sources: SourceEntry[] }, sourceName: string): SourceEntry | undefined {
  return data.sources.find((source) => source.name === sourceName);
}

export function getPromptContent(
  dir: string | undefined,
  target: PromptTarget,
  sourceName?: string,
): string {
  const d = configDir(dir);

  if (target === 'source') {
    if (!sourceName) {
      throw new Error('Source prompt requires a `source` name.');
    }
    const data = readSources(d);
    const source = findSource(data, sourceName);
    if (!source) {
      throw new Error(`Source \`${sourceName}\` not found.`);
    }
    return String(source.prompt ?? '');
  }

  if (target === 'judge') {
    const data = readYamlSafe(path.join(d, 'judge.yaml'));
    return String(data?.rules ?? '');
  }

  if (target === 'reactor') {
    const data = readYamlSafe(path.join(d, 'reactor.yaml'));
    return String(data?.rules ?? '');
  }

  return readBrandContext(d);
}

export function handlePromptView(
  dir: string | undefined,
  target: PromptTarget,
  sourceName?: string,
): ConfigCommandResult {
  try {
    const content = getPromptContent(dir, target, sourceName);
    const title = target === 'source'
      ? `**${sourceName} prompt**`
      : target === 'judge'
        ? '**judge.yaml rules**'
        : target === 'reactor'
          ? '**reactor.yaml rules**'
          : '**brand_context.md**';
    return {
      success: true,
      message: `${title}\n\`\`\`\n${truncateForDiscord(content)}\n\`\`\``,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
}

export function handlePromptSet(
  dir: string | undefined,
  target: PromptTarget,
  content: string,
  userId: string,
  sourceName?: string,
): ConfigCommandResult {
  const d = configDir(dir);
  const trimmed = content.trim();
  if (!trimmed) {
    return { success: false, message: 'Prompt content cannot be empty.' };
  }

  if (target === 'source') {
    if (!sourceName) {
      return { success: false, message: 'Source prompt update requires a `source` name.' };
    }
    const data = readSources(d);
    const source = findSource(data, sourceName);
    if (!source) {
      return { success: false, message: `Source \`${sourceName}\` not found.` };
    }
    source.prompt = trimmed;
    writeSources(d, data);
    return {
      success: true,
      message: `Updated **${sourceName}** prompt (${trimmed.length} chars). Hot reload will apply on the next run.`,
    };
  }

  if (target === 'judge') {
    const filePath = path.join(d, 'judge.yaml');
    const data = readYamlSafe(filePath);
    data.rules = trimmed;
    writeYamlSafe(filePath, data);
    return {
      success: true,
      message: `Updated **judge.yaml** rules (${trimmed.length} chars). Hot reload will apply on the next run.`,
    };
  }

  if (target === 'reactor') {
    const filePath = path.join(d, 'reactor.yaml');
    const data = readYamlSafe(filePath);
    data.rules = trimmed;
    writeYamlSafe(filePath, data);
    return {
      success: true,
      message: `Updated **reactor.yaml** rules (${trimmed.length} chars). Hot reload will apply on the next run.`,
    };
  }

  writeBrandContext(d, trimmed);
  return {
    success: true,
    message: `Updated **brand_context.md** (${trimmed.length} chars). Hot reload will apply on the next run.`,
  };
}

// ─── Config Overview ───

export function handleConfigView(dir?: string): ConfigCommandResult {
  const d = configDir(dir);
  const accounts = readAccounts(d);
  const sourceData = readSources(d);

  const accountSummary = Object.entries(accounts)
    .map(([g, entries]) => `  ${g}: ${entries.length}`)
    .join('\n');
  const sourceSummary = sourceData.sources
    .map((s) => `  ${s.name}: \`${s.schedule}\``)
    .join('\n');

  return {
    success: true,
    message: [
      '**Config Overview**',
      '',
      `**Accounts** (${Object.keys(accounts).length} groups):`,
      accountSummary,
      '',
      `**Sources** (${sourceData.sources.length}):`,
      sourceSummary,
    ].join('\n'),
  };
}

// ─── Governance ───

export function handleGovernanceList(dir?: string): ConfigCommandResult {
  const governance = readGovernance(configDir(dir));

  return {
    success: true,
    message: [
      '**Config Governance**',
      '',
      `admin_user_ids: ${governance.admin_user_ids.length ? governance.admin_user_ids.map((id) => `\`${id}\``).join(', ') : '—'}`,
      `admin_role_ids: ${governance.admin_role_ids.length ? governance.admin_role_ids.map((id) => `\`${id}\``).join(', ') : '—'}`,
      `allowed_user_ids: ${governance.allowed_user_ids.length ? governance.allowed_user_ids.map((id) => `\`${id}\``).join(', ') : '—'}`,
      `allowed_role_ids: ${governance.allowed_role_ids.length ? governance.allowed_role_ids.map((id) => `\`${id}\``).join(', ') : '—'}`,
      `allowed_channel_ids: ${governance.allowed_channel_ids.length ? governance.allowed_channel_ids.map((id) => `\`${id}\``).join(', ') : '—'}`,
    ].join('\n'),
  };
}

export function readGovernanceConfig(dir?: string): GovernanceConfig {
  try {
    return readGovernance(configDir(dir));
  } catch {
    return { ...EMPTY_GOVERNANCE };
  }
}

export function handleGovernanceAddUser(
  dir: string | undefined,
  userId: string,
  target: 'admin_user_ids' | 'allowed_user_ids',
): ConfigCommandResult {
  const d = configDir(dir);
  const governance = readGovernanceConfig(d);
  if (!addId(governance[target], userId)) {
    return { success: false, message: `\`${userId}\` already exists in \`${target}\`.` };
  }
  writeGovernance(d, governance);
  return { success: true, message: `Added \`${userId}\` to \`${target}\`.` };
}

export function handleGovernanceRemoveUser(
  dir: string | undefined,
  userId: string,
  target: 'admin_user_ids' | 'allowed_user_ids',
): ConfigCommandResult {
  const d = configDir(dir);
  const governance = readGovernanceConfig(d);
  if (!removeId(governance[target], userId)) {
    return { success: false, message: `\`${userId}\` not found in \`${target}\`.` };
  }
  writeGovernance(d, governance);
  return { success: true, message: `Removed \`${userId}\` from \`${target}\`.` };
}

export function handleGovernanceAddRole(
  dir: string | undefined,
  roleId: string,
  target: 'admin_role_ids' | 'allowed_role_ids',
): ConfigCommandResult {
  const d = configDir(dir);
  const governance = readGovernanceConfig(d);
  if (!addId(governance[target], roleId)) {
    return { success: false, message: `\`${roleId}\` already exists in \`${target}\`.` };
  }
  writeGovernance(d, governance);
  return { success: true, message: `Added \`${roleId}\` to \`${target}\`.` };
}

export function handleGovernanceRemoveRole(
  dir: string | undefined,
  roleId: string,
  target: 'admin_role_ids' | 'allowed_role_ids',
): ConfigCommandResult {
  const d = configDir(dir);
  const governance = readGovernanceConfig(d);
  if (!removeId(governance[target], roleId)) {
    return { success: false, message: `\`${roleId}\` not found in \`${target}\`.` };
  }
  writeGovernance(d, governance);
  return { success: true, message: `Removed \`${roleId}\` from \`${target}\`.` };
}

export function handleGovernanceSetChannel(
  dir: string | undefined,
  channelId: string,
): ConfigCommandResult {
  const d = configDir(dir);
  const governance = readGovernanceConfig(d);
  governance.allowed_channel_ids = uniqueSorted([channelId.trim()]);
  writeGovernance(d, governance);
  return { success: true, message: `Set config command channel to \`${channelId}\`.` };
}

export function handleGovernanceClearChannel(dir?: string): ConfigCommandResult {
  const d = configDir(dir);
  const governance = readGovernanceConfig(d);
  governance.allowed_channel_ids = [];
  writeGovernance(d, governance);
  return { success: true, message: 'Cleared config command channel restriction.' };
}
