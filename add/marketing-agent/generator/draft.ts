import { callClaudeText } from '../../src/claude-sdk.js';
import type { DraftTone, PipelineSignal, ToneItem } from '../types/index.js';
import { loadGeneratorConfig } from '../engine/config-loader.js';
import * as fs from 'fs';
import * as path from 'path';

function readSecret(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const envFile = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      if (k !== key) continue;
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v || undefined;
    }
  } catch {}
  return undefined;
}

// Defaults — overridden by generator.yaml when loaded via loadGeneratorConfig
let MODEL = 'claude-sonnet-4-5-20250514';
let TEMPERATURE = 0.7;
let MAX_TOKENS = 400;
let BRAND_CONTEXT_REF: string | undefined;

/**
 * 从 generator.yaml 配置初始化 Generator 参数。
 * 由 discord.ts 在启动时调用一次。不调用则使用默认值。
 */
export function initGeneratorConfig(config: { model: string; temperature: number; max_tokens: number; brand_context_ref: string }): void {
  const brandContextChanged = BRAND_CONTEXT_REF !== config.brand_context_ref;
  MODEL = config.model;
  TEMPERATURE = config.temperature;
  MAX_TOKENS = config.max_tokens;
  BRAND_CONTEXT_REF = config.brand_context_ref;
  if (brandContextChanged) {
    cachedBrandContext = null;
  }
}

let cachedBrandContext: string | null = null;

export function loadGeneratorRuntimeConfig(configDir = 'marketing-agent/config'): void {
  const generatorConfig = loadGeneratorConfig(path.resolve(process.cwd(), configDir, 'generator.yaml'));
  initGeneratorConfig(generatorConfig);
}

function loadBrandContext(brandContextPath?: string): string {
  if (cachedBrandContext) return cachedBrandContext;
  
  const filePath = brandContextPath || 'prompts/brand_context.md';
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
    if (fs.existsSync(fullPath)) {
      cachedBrandContext = fs.readFileSync(fullPath, 'utf-8');
      return cachedBrandContext;
    }
    console.warn(`[draft] Brand context file not found: ${fullPath}, using minimal prompt`);
    return '';
  } catch (err) {
    console.warn(`[draft] Failed to load brand context: ${err}, using minimal prompt`);
    return '';
  }
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Draft response does not contain a JSON object');
  }

  return trimmed.slice(start, end + 1);
}

function buildSystemPrompt(signal: PipelineSignal, selectedTone: ToneItem, brandContextPath?: string): string {
  const brandContext = loadBrandContext(brandContextPath ?? BRAND_CONTEXT_REF);
  const parts: string[] = [];
  
  if (brandContext) {
    parts.push('Brand Context:', brandContext, '');
  }
  
  parts.push(
    'You write social media replies for Byreal, a DeFi/Web3 trading platform.',
    'Produce concise, brand-safe replies under 280 characters each.',
    'Do not overpromise. Do not mention private or unverifiable facts.',
    'Return the reply as plain text. No JSON. No markdown.',
    '',
    `Action: ${signal.suggestedAction ?? signal.actionType}`,
    `Reply direction: ${signal.replyAngle ?? signal.angle}`,
    '',
    'You MUST follow this selected tone exactly:',
    JSON.stringify(selectedTone, null, 2),
    '',
    'Use the selected tone description to shape wording, specificity, and call-to-action.',
  );
  
  return parts.join('\n');
}


function parseSingleToneText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Empty single-tone draft response');
  }

  // Strip markdown code fences first (e.g. ```json\n{...}\n```)
  const fenceMatch = trimmed.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  const stripped = fenceMatch ? fenceMatch[1].trim() : trimmed;

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const text = parsed.text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    throw new Error('Single-tone JSON response missing text');
  }

  return stripped;
}

function fallbackSingleToneDraft(signal: PipelineSignal, _strategy: string): string {
  const author = signal.author;
  const action = signal.suggestedAction ?? signal.actionType;

  if (action === 'reply_supportive' || action === 'reply') {
    return `Thanks for the mention, @${author}. We appreciate it and are glad to engage on this.`;
  }
  if (action === 'qrt_positioning' || action === 'qrt') {
    return `@${author} Great point. On Byreal we're focused on practical execution, happy to share details if useful.`;
  }
  if (action === 'escalate_internal' || action === 'monitor') {
    return `@${author} Thanks for flagging this. We're monitoring closely and keeping communication clear as facts develop.`;
  }
  return `@${author} Thanks for sharing. We're following this and will continue to engage thoughtfully.`;
}

function buildSingleToneUserPrompt(signal: PipelineSignal, tone: ToneItem, context?: string): string {
  const contextSection = context ? `Additional context from team: ${context}\n\n` : '';
  return [
    'Generate exactly one reply variant for this tweet.',
    contextSection,
    `Required tone id: ${tone.id}`,
    `Required tone label: ${tone.label}`,
    `Required tone description: ${tone.description}`,
    `Author: ${signal.author}`,
    `Action: ${signal.suggestedAction ?? signal.actionType}`,
    `Reply direction: ${signal.replyAngle ?? signal.angle}`,
    `Tweet: ${signal.content}`,
    'Output ONLY the plain text reply. No JSON wrapping. No markdown fences. No quotes around the text.',
    'Do not output multiple variants.',
  ].join('\n');
}

export async function generateSingleToneDraft(signal: PipelineSignal, tone: DraftTone, context?: string): Promise<string> {
  const selectedTone = signal.tones.find((item) => item.id === tone)
    ?? signal.tones.find((item) => item.label === tone)
    ?? signal.tones[0];
  if (!selectedTone) {
    return fallbackSingleToneDraft(signal, tone);
  }

  const mocked = process.env.MOCK_DRAFT_RESPONSE;
  if (mocked) {
    const parsed = JSON.parse(extractJsonObject(mocked)) as Record<string, unknown>;
    const mockText = parsed[tone];
    if (typeof mockText === 'string' && mockText.trim()) return mockText.trim();
  }

  if (!readSecret('CLAUDE_CODE_OAUTH_TOKEN') && !readSecret('ANTHROPIC_API_KEY')) {
    return fallbackSingleToneDraft(signal, tone);
  }

  const systemPrompt = [
    buildSystemPrompt(signal, selectedTone),
    'Generate only one reply in the requested tone.',
    'Return plain text only. No JSON. No code fences.',
  ].join('\n');
  const userPrompt = buildSingleToneUserPrompt(signal, selectedTone, context);

  try {
    const raw = await callClaudeText({
      systemPrompt,
      userPrompt,
      model: MODEL,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
    });
    return parseSingleToneText(raw);
  } catch {
    const retryRaw = await callClaudeText({
      systemPrompt,
      userPrompt: `${userPrompt}\nReturn one reply only. No markdown fences.`,
      model: MODEL,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
    });
    return parseSingleToneText(retryRaw);
  }
}
