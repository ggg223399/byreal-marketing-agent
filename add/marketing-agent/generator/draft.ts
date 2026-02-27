import { callClaudeText } from '../lib/claude-client.js';
import { SIGNAL_CATEGORIES } from '../types/index.js';
import type { DraftReply, DraftTone, DraftVariant, Signal, SignalCategory } from '../types/index.js';
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

const MODEL = 'claude-3-5-haiku-20241022';
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

const RECOMMENDED_TONES: Record<SignalCategory, [DraftTone, DraftTone]> = {
  0: ['friendly_peer', 'humble_ack'],
  1: ['helpful_expert', 'friendly_peer'],
  2: ['helpful_expert', 'friendly_peer'],
  3: ['helpful_expert', 'friendly_peer'],
  4: ['helpful_expert', 'friendly_peer'],
  5: ['helpful_expert', 'friendly_peer'],
  6: ['humble_ack', 'direct_rebuttal'],
  7: ['friendly_peer', 'humble_ack'],
  8: ['direct_rebuttal', 'helpful_expert'],
};

export function getRecommendedTones(category: SignalCategory): [DraftTone, DraftTone] {
  return RECOMMENDED_TONES[category];
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

function parseVariants(raw: string): DraftVariant[] {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const helpfulExpert = parsed.helpful_expert;
  const friendlyPeer = parsed.friendly_peer;
  const humbleAck = parsed.humble_ack;
  const directRebuttal = parsed.direct_rebuttal;

  if (typeof helpfulExpert !== 'string' || !helpfulExpert.trim()) {
    throw new Error('Missing helpful_expert draft');
  }
  if (typeof friendlyPeer !== 'string' || !friendlyPeer.trim()) {
    throw new Error('Missing friendly_peer draft');
  }
  if (typeof humbleAck !== 'string' || !humbleAck.trim()) {
    throw new Error('Missing humble_ack draft');
  }
  if (typeof directRebuttal !== 'string' || !directRebuttal.trim()) {
    throw new Error('Missing direct_rebuttal draft');
  }

  return [
    { tone: 'helpful_expert', text: helpfulExpert.trim() },
    { tone: 'friendly_peer', text: friendlyPeer.trim() },
    { tone: 'humble_ack', text: humbleAck.trim() },
    { tone: 'direct_rebuttal', text: directRebuttal.trim() },
  ];
}

function buildSystemPrompt(brandContextPath?: string): string {
  const brandContext = loadBrandContext(brandContextPath);
  const parts: string[] = [];
  
  if (brandContext) {
    parts.push('Brand Context:', brandContext, '');
  }
  
  parts.push(
    'You write social media replies for Byreal, a DeFi/Web3 trading platform.',
    'Produce concise, brand-safe replies under 280 characters each.',
    'Do not overpromise. Do not mention private or unverifiable facts.',
    'Return strict JSON only.',
    '',
    'Tone guide:',
    '- helpful_expert: Professional, authoritative, offers concrete value and expertise.',
    '- friendly_peer: Casual, relatable, peer-to-peer energy, approachable and warm.',
    '- humble_ack: Grateful, appreciative, acknowledges without being pushy.',
    '- direct_rebuttal: Addresses concerns constructively, empathetic but clear.'
  );
  
  return parts.join('\n');
}


function buildUserPrompt(signal: Signal): string {
  const categoryName = SIGNAL_CATEGORIES[signal.category] ?? 'unknown_category';
  return [
    'Generate exactly four reply variants for this tweet.',
    `Author: ${signal.author}`,
    `Category: ${signal.category} (${categoryName})`,
    `Tweet: ${signal.content}`,
    'Output JSON object with keys:',
    '{"helpful_expert":"...","friendly_peer":"...","humble_ack":"...","direct_rebuttal":"..."}',
  ].join('\n');
}

function parseSingleToneText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Empty single-tone draft response');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const text = parsed.text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    throw new Error('Single-tone JSON response missing text');
  }

  return trimmed;
}

function fallbackSingleToneDraft(signal: Signal, tone: DraftTone): string {
  if (tone === 'helpful_expert') {
    return `Byreal is built for this use case, @${signal.author} - tighter execution, clearer market context, and practical risk controls for active DeFi traders.`;
  }
  if (tone === 'friendly_peer') {
    return `Great call, @${signal.author} - Byreal has been a smooth setup for tracking positions and reacting faster. Happy to share what is working.`;
  }
  if (tone === 'humble_ack') {
    return `Appreciate it, @${signal.author}! Thanks for the mention - let us know if there is anything you'd like us to improve.`;
  }
  return `Fair point, @${signal.author}. We are actively improving reliability and transparency - if you share the exact pain point, we can address it directly.`;
}

function buildSingleToneUserPrompt(signal: Signal, tone: DraftTone, context?: string): string {
  const categoryName = SIGNAL_CATEGORIES[signal.category] ?? 'unknown_category';
  const contextSection = context ? `Additional context from team: ${context}\n\n` : '';
  return [
    'Generate exactly one reply variant for this tweet.',
    contextSection,
    `Required tone: ${tone}`,
    `Author: ${signal.author}`,
    `Category: ${signal.category} (${categoryName})`,
    `Tweet: ${signal.content}`,
    'Output either plain text reply only OR JSON object: {"text":"..."}.',
    'Do not output multiple variants.',
  ].join('\n');
}

export async function generateSingleToneDraft(signal: Signal, tone: DraftTone, context?: string): Promise<string> {
  const mocked = process.env.MOCK_DRAFT_RESPONSE;
  if (mocked) {
    const variants = parseVariants(mocked);
    const match = variants.find((item) => item.tone === tone);
    if (match?.text) {
      return match.text;
    }
  }

  if (!readSecret('CLAUDE_CODE_OAUTH_TOKEN') && !readSecret('ANTHROPIC_API_KEY')) {
    return fallbackSingleToneDraft(signal, tone);
  }

  const systemPrompt = [
    buildSystemPrompt(),
    'Generate only one reply in the requested tone.',
    'Return plain text or JSON object with a single "text" field.',
  ].join('\n');
  const userPrompt = buildSingleToneUserPrompt(signal, tone, context);

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

export async function generateDraft(signal: Signal): Promise<DraftReply> {
  const mocked = process.env.MOCK_DRAFT_RESPONSE;
  if (mocked) {
    return {
      signalId: signal.id,
      variants: parseVariants(mocked),
      generatedAt: Math.floor(Date.now() / 1000),
    };
  }

  if (!readSecret('CLAUDE_CODE_OAUTH_TOKEN') && !readSecret('ANTHROPIC_API_KEY')) {
    return {
      signalId: signal.id,
      variants: [
        {
          tone: 'helpful_expert',
          text: `Byreal offers exactly what you need, ${signal.author}. Built for serious DeFi participants with real-time analytics and liquidity optimization.`,
        },
        {
          tone: 'friendly_peer',
          text: `Hey ${signal.author}! Using Byreal here — it's been solid for managing positions. Happy to share more!`,
        },
        {
          tone: 'humble_ack',
          text: `Thanks for the mention, ${signal.author}! Really appreciate it. Let us know if there's anything we can help with.`,
        },
        {
          tone: 'direct_rebuttal',
          text: `We hear you, ${signal.author}. Here's what Byreal does differently: [feature]. Happy to address any specific concerns!`,
        },
      ],
      generatedAt: Math.floor(Date.now() / 1000),
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(signal);

  try {
    const raw = await callClaudeText({
      systemPrompt,
      userPrompt,
      model: MODEL,
      temperature: TEMPERATURE,
      maxTokens: 1200,
    });

    return {
      signalId: signal.id,
      variants: parseVariants(raw),
      generatedAt: Math.floor(Date.now() / 1000),
    };
  } catch {
    const retryRaw = await callClaudeText({
      systemPrompt,
      userPrompt: `${userPrompt}\nOnly output valid JSON object. No markdown fences or additional text.`,
      model: MODEL,
      temperature: TEMPERATURE,
      maxTokens: 1200,
    });

    return {
      signalId: signal.id,
      variants: parseVariants(retryRaw),
      generatedAt: Math.floor(Date.now() / 1000),
    };
  }
}
