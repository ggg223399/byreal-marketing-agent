import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ALERT_LEVELS, SUGGESTED_ACTIONS } from './types.js';
import type { SourcesConfig, JudgeConfig, ReactorConfig, RoutingConfig, EnrichmentConfig, SchemaFieldEnum } from './types.js';
import { validateFieldConfig } from './output-schema.js';

function validateEnumField(
  field: SchemaFieldEnum,
  allowedValues: string[],
  pathLabel: string,
): void {
  const invalid = field.values.filter((value) => !allowedValues.includes(value));
  if (invalid.length > 0) {
    throw new Error(`${pathLabel}: unsupported enum values: ${invalid.join(', ')}`);
  }
}

/**
 * 读取并解析指定路径的 YAML 文件，返回泛型类型 T。
 * 若文件不存在则抛出错误。
 */
function readYaml<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const text = readFileSync(filePath, 'utf-8');
  return parse(text) as T;
}

/**
 * 加载并校验 sources.yaml 配置。
 * 校验内容：
 * - sources 字段必须是非空数组
 * - 每个 source 必须有 name、schedule、prompt
 * - skip_judge=true 时必须提供 default_labels
 * - source name 不能重复
 * @param filePath sources.yaml 的绝对路径
 */
export function loadSourcesConfig(filePath: string): SourcesConfig {
  const raw = readYaml<SourcesConfig>(filePath);
  if (!raw.sources || !Array.isArray(raw.sources)) {
    throw new Error('sources.yaml: missing "sources" array');
  }
  for (const s of raw.sources) {
    if (!s.name) throw new Error('sources.yaml: source missing "name"');
    if (!s.schedule) throw new Error(`sources.yaml: source "${s.name}" missing "schedule"`);
    if (!s.prompt) throw new Error(`sources.yaml: source "${s.name}" missing "prompt"`);
    const sourceGroups = s.groups ?? s.account_groups;
    if (sourceGroups && !s.accounts_ref) {
      throw new Error(`sources.yaml: source "${s.name}" has account filters but no accounts_ref`);
    }
    // skip_judge 模式下必须提供默认标签，否则无法路由
    if (s.skip_judge && !s.default_labels) {
      throw new Error(`sources.yaml: source "${s.name}" has skip_judge=true but no default_labels`);
    }
  }
  // 检测重复的 source name
  const names = raw.sources.map(s => s.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`sources.yaml: duplicate source names: ${dupes.join(', ')}`);
  }
  return raw;
}

/**
 * 加载并校验 judge.yaml 配置。
 * 必须包含 rules 字段和 output_schema.alertLevel。
 * @param filePath judge.yaml 的绝对路径
 */
export function loadJudgeConfig(filePath: string): JudgeConfig {
  const raw = readYaml<JudgeConfig>(filePath);
  if (!raw.rules) throw new Error('judge.yaml: missing "rules"');
  if (!raw.output_schema?.alertLevel) throw new Error('judge.yaml: missing output_schema.alertLevel');
  if (!raw.output_schema?.reasoning) throw new Error('judge.yaml: missing output_schema.reasoning');
  if (!validateFieldConfig(raw.output_schema.alertLevel)) throw new Error('judge.yaml: invalid output_schema.alertLevel');
  if (!validateFieldConfig(raw.output_schema.reasoning)) throw new Error('judge.yaml: invalid output_schema.reasoning');
  validateEnumField(raw.output_schema.alertLevel, ALERT_LEVELS, 'judge.yaml: output_schema.alertLevel');
  // 动态裁剪模式校验：source_rules 和 source_category_map 必须同时存在
  if (raw.source_rules && !raw.source_category_map) {
    throw new Error('judge.yaml: source_rules requires source_category_map');
  }
  if (raw.source_category_map && !raw.source_rules) {
    throw new Error('judge.yaml: source_category_map requires source_rules');
  }
  return raw;
}

/**
 * 加载并校验 reactor.yaml 配置。
 * 必须包含 rules、output_schema.suggestedAction 和 output_schema.tones。
 * @param filePath reactor.yaml 的绝对路径
 */
export function loadReactorConfig(filePath: string): ReactorConfig {
  const raw = readYaml<ReactorConfig>(filePath);
  if (!raw.rules) throw new Error('reactor.yaml: missing "rules"');
  if (!raw.output_schema?.suggestedAction) throw new Error('reactor.yaml: missing output_schema.suggestedAction');
  if (!raw.output_schema?.tones) throw new Error('reactor.yaml: missing output_schema.tones');
  if (!raw.output_schema?.replyAngle) throw new Error('reactor.yaml: missing output_schema.replyAngle');
  if (!validateFieldConfig(raw.output_schema.suggestedAction)) throw new Error('reactor.yaml: invalid output_schema.suggestedAction');
  if (!validateFieldConfig(raw.output_schema.replyAngle)) throw new Error('reactor.yaml: invalid output_schema.replyAngle');
  validateEnumField(raw.output_schema.suggestedAction, SUGGESTED_ACTIONS, 'reactor.yaml: output_schema.suggestedAction');
  // Validate tones is an array field with required item_fields
  const tonesField = raw.output_schema.tones as unknown as Record<string, unknown>;
  if (tonesField.type !== 'array') throw new Error('reactor.yaml: output_schema.tones must have type "array"');
  const requiredItemFields = ['id', 'label', 'description'];
  const itemFields = tonesField.item_fields as string[] | undefined;
  if (!itemFields || !requiredItemFields.every((f) => itemFields.includes(f))) {
    throw new Error(`reactor.yaml: output_schema.tones.item_fields must contain: ${requiredItemFields.join(', ')}`);
  }
  if (raw.source_rules && !raw.source_category_map) {
    throw new Error('reactor.yaml: source_rules requires source_category_map');
  }
  if (raw.source_category_map && !raw.source_rules) {
    throw new Error('reactor.yaml: source_category_map requires source_rules');
  }
  return raw;
}

/**
 * 加载并校验 routing.yaml 配置。
 * 必须包含 routing.default.channel 和至少一条路由规则。
 * @param filePath routing.yaml 的绝对路径
 */
export function loadRoutingConfig(filePath: string): RoutingConfig {
  const raw = readYaml<RoutingConfig>(filePath);
  if (!raw.routing) throw new Error('routing.yaml: missing "routing"');
  if (!raw.routing.default?.channel) throw new Error('routing.yaml: missing routing.default.channel');
  if (!raw.routing.routes || raw.routing.routes.length === 0) {
    throw new Error('routing.yaml: must have at least one route');
  }
  return raw;
}

/**
 * 将模板字符串中的 `{{变量名}}` 占位符替换为对应的变量值。
 * 若变量不存在则保留原始占位符不变。
 * @param template 包含 `{{key}}` 占位符的模板字符串
 * @param vars     键值对映射表
 * @returns 替换后的字符串
 */
export function resolveTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

/**
 * Resolve a config-relative file reference.
 * Accepts both `accounts.yaml` and legacy `config/accounts.yaml` forms.
 */
export function resolveConfigRefPath(configDir: string, refPath: string): string {
  const normalizedRef = refPath.replace(/\\/g, '/');
  const relativeRef = normalizedRef.startsWith('config/')
    ? normalizedRef.slice('config/'.length)
    : normalizedRef;
  return path.resolve(configDir, relativeRef);
}

/**
 * 从 accounts YAML 文件中加载账号 handle 列表。
 * @param filePath accounts YAML 的绝对路径
 * @returns handle 字符串数组
 */
export function loadAccountsList(
  filePath: string,
  options?: { groups?: string[] },
): string[] {
  const raw = readYaml<{
    accounts?: Record<string, Array<{ handle?: string; hanlde?: string }>>;
  }>(filePath);

  if (raw.accounts && typeof raw.accounts === 'object') {
    const groupAliases: Record<string, string[]> = {
      core: ['core', 'O', 'S'],
      ecosystem: ['ecosystem', 'A'],
      competitor: ['competitor', 'B'],
      context: ['context', 'C'],
    };
    const keys = options?.groups?.length
      ? Array.from(new Set(options.groups.flatMap((group) => groupAliases[group] ?? [group])))
      : Object.keys(raw.accounts);
    const handles = keys.flatMap((key) => {
      const accounts = raw.accounts?.[key] ?? [];
      return accounts
        .map((account) => {
          const rawHandle = account.handle ?? account.hanlde ?? '';
          return rawHandle.trim().replace(/^@+/, '');
        })
        .filter(Boolean);
    });
    return Array.from(new Set(handles));
  }

  return [];
}

/**
 * 读取品牌上下文文件（纯文本），供 reactor 生成回复时使用。
 * @param filePath 品牌上下文文件的绝对路径
 * @returns 文件的原始文本内容
 */
export function loadBrandContext(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Brand context file not found: ${filePath}`);
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * 加载并校验 enrichment.yaml 配置。
 * 必须包含 enrichment.delay_minutes（数字）和 enrichment.schedule。
 * @param filePath enrichment.yaml 的绝对路径
 */
export function loadEnrichmentConfig(filePath: string): EnrichmentConfig {
  const raw = readYaml<EnrichmentConfig>(filePath);
  if (!raw.enrichment) throw new Error('enrichment.yaml: missing "enrichment"');
  if (typeof raw.enrichment.delay_minutes !== 'number') throw new Error('enrichment.yaml: missing enrichment.delay_minutes');
  if (!raw.enrichment.schedule) throw new Error('enrichment.yaml: missing enrichment.schedule');
  return raw;
}

/**
 * Generator 配置（generator.yaml），控制草稿生成的模型和参数。
 */
export interface GeneratorConfig {
  model: string;
  temperature: number;
  max_tokens: number;
  brand_context_ref: string;
}

/**
 * 加载并校验 generator.yaml 配置。
 * @param filePath generator.yaml 的绝对路径
 */
export function loadGeneratorConfig(filePath: string): GeneratorConfig {
  const raw = readYaml<GeneratorConfig>(filePath);
  if (!raw.model) throw new Error('generator.yaml: missing "model"');
  if (typeof raw.temperature !== 'number') throw new Error('generator.yaml: missing "temperature"');
  if (typeof raw.max_tokens !== 'number') throw new Error('generator.yaml: missing "max_tokens"');
  if (!raw.brand_context_ref) throw new Error('generator.yaml: missing "brand_context_ref"');
  return raw;
}

/**
 * 聚合所有配置的容器接口，由 `loadAllConfigs` 一次性返回。
 */
export interface AllConfigs {
  sources: SourcesConfig;
  judge: JudgeConfig;
  reactor: ReactorConfig;
  routing: RoutingConfig;
  enrichment: EnrichmentConfig;
  generator: GeneratorConfig;
}

/**
 * 从指定目录一次性加载全部配置文件并返回聚合对象。
 * 期望目录下存在：sources.yaml、judge.yaml、reactor.yaml、routing.yaml、enrichment.yaml、generator.yaml。
 * @param configDir 配置文件所在目录的绝对路径
 */
export function loadAllConfigs(configDir: string): AllConfigs {
  return {
    sources: loadSourcesConfig(path.join(configDir, 'sources.yaml')),
    judge: loadJudgeConfig(path.join(configDir, 'judge.yaml')),
    reactor: loadReactorConfig(path.join(configDir, 'reactor.yaml')),
    routing: loadRoutingConfig(path.join(configDir, 'routing.yaml')),
    enrichment: loadEnrichmentConfig(path.join(configDir, 'enrichment.yaml')),
    generator: loadGeneratorConfig(path.join(configDir, 'generator.yaml')),
  };
}
