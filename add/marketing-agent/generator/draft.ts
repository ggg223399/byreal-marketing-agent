import { callClaudeText } from '../lib/claude-client.js';
import type { DraftTone, PipelineSignal, ToneItem } from '../types/index.js';
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

const MODEL = 'claude-sonnet-4-5-20250514';
const TEMPERATURE = 0.7;

let cachedBrandContext: string | null = null;

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
  const brandContext = loadBrandContext(brandContextPath);
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
    `Signal pipeline: ${signal.pipeline}`,
    `Signal action type: ${signal.actionType}`,
    `Signal angle: ${signal.angle}`,
    'LLM-recommended tones (JSON array):',
    JSON.stringify(signal.tones, null, 2),
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

function fallbackSingleToneDraft(signal: PipelineSignal, strategy: string): string {
  const author = signal.author;
  if (signal.pipeline === 'mentions') {
    return `Thanks for the mention, @${author}. We appreciate it and are glad to see this conversation around ${signal.angle}.`;
  }
  if (signal.pipeline === 'network') {
    return `@${author} Great point. On Byreal we're focused on practical execution for ${signal.angle}, happy to share details if useful.`;
  }
  if (signal.pipeline === 'trends') {
    return `@${author} Interesting trend. We're watching ${signal.angle} closely and thinking through where it creates real user value.`;
  }
  if (signal.pipeline === 'crisis') {
    return `@${author} Thanks for flagging this. We're monitoring ${signal.angle} closely and keeping communication clear as facts develop.`;
  }
  return `@${author} Thanks for sharing. We're following this (${strategy}) and will continue to engage thoughtfully.`;
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
    `Pipeline: ${signal.pipeline}`,
    `Action Type: ${signal.actionType}`,
    `Angle: ${signal.angle}`,
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
      maxTokens: 400,
    });
    return parseSingleToneText(raw);
  } catch {
    const retryRaw = await callClaudeText({
      systemPrompt,
      userPrompt: `${userPrompt}\nReturn one reply only. No markdown fences.`,
      model: MODEL,
      temperature: TEMPERATURE,
      maxTokens: 400,
    });
    return parseSingleToneText(retryRaw);
  }
}
