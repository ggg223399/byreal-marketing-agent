import { callClaudeText } from '../lib/claude-client.js';
import { SIGNAL_CATEGORIES } from '../types/index.js';
import type { DraftTone, Signal } from '../types/index.js';
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
    'Strategy guide (generate reply matching the strategy):',
    '- thank_support: Warmly thank and acknowledge. Show genuine appreciation.',
    '- add_detail: Add specific product features, data points, or context about Byreal.',
    '- invite_try: Friendly invitation to try specific Byreal features. Include concrete value prop.',
    '- data_compare: Present objective data comparison. Use numbers and facts.',
    '- differentiate: Highlight what makes Byreal unique. Concrete advantages over alternatives.',
    '- objective_take: Professional, balanced analysis. Acknowledge strengths of others too.',
    '- share_insight: Share a valuable market insight or perspective. Be informative.',
    '- offer_solution: Propose a practical solution or approach. Be actionable.',
    '- show_interest: Express genuine interest and engagement. Ask smart follow-up questions.',
    '- add_data: Supplement with relevant data points. Be precise.',
    '- trend_analysis: Interpret trends and their implications. Forward-looking.',
    '- team_perspective: Share team viewpoint. Authentic insider perspective.',
    '- positive_engage: Enthusiastic, positive engagement. Celebrate the news/development.',
    '- collab_intent: Express collaboration interest. Be specific about potential synergies.',
    '- share_progress: Share Byreal related progress. Concrete updates.',
    '- industry_insight: Deep industry knowledge. Thought leadership.',
    '- tech_vision: Technical perspective on the topic. Expert-level.',
    '- express_interest: Express strategic interest. Show Byreal is paying attention.',
    '- expert_analysis: Professional expert analysis. Authoritative.',
    '- compliance_view: Compliance/regulatory angle. Thoughtful and measured.',
    '- market_view: Market perspective. Data-informed opinion.',
    '- safety_alert: Safety awareness. Responsible, helpful, not alarmist.',
    '- fact_clarify: Clarify facts objectively. Evidence-based.',
    '- official_response: Official Byreal response. Measured, authoritative, transparent.',
  );
  
  return parts.join('\n');
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

function fallbackSingleToneDraft(signal: Signal, strategy: string): string {
  const author = signal.author;
  const strategyFallbacks: Record<string, string> = {
    thank_support: `Thanks for the mention, @${author}! We really appreciate the support. Let us know if there's anything we can help with.`,
    add_detail: `@${author} Great point! Byreal's concentrated liquidity pools offer tighter spreads and better capital efficiency for active LPs.`,
    invite_try: `@${author} You should check out Byreal's Real Farmer feature - social copy-LP that makes DeFi accessible. Would love your feedback!`,
    data_compare: `Interesting data, @${author}. On Byreal we're seeing strong LP returns with concentrated liquidity - happy to share specifics.`,
    differentiate: `@${author} What sets Byreal apart: CLMM with social copy-LP, Bybit Alpha integration, and optimized new asset launches on Solana.`,
    objective_take: `Good analysis, @${author}. The landscape is evolving fast - Byreal's approach focuses on capital efficiency and LP experience.`,
    share_insight: `@${author} Our take: this signals growing demand for efficient liquidity solutions on Solana. Exciting times ahead.`,
    offer_solution: `@${author} Byreal can help here - our CLMM pools are designed exactly for this use case. Happy to walk you through it.`,
    show_interest: `Really interesting development, @${author}. We're watching this closely at Byreal. What's your take on the next steps?`,
    safety_alert: `@${author} Important reminder to stay vigilant. Always verify contract addresses and use trusted platforms.`,
    fact_clarify: `@${author} To clarify the facts here - happy to provide specific data points from Byreal's side.`,
    official_response: `@${author} Thanks for raising this. Here's Byreal's position: we prioritize transparency and user safety above all.`,
  };
  return strategyFallbacks[strategy] || `Thanks for sharing, @${author}. Interesting perspective - the Byreal team is paying attention.`;
}

function buildSingleToneUserPrompt(signal: Signal, tone: DraftTone, context?: string): string {
  const categoryName = SIGNAL_CATEGORIES[signal.category] ?? 'unknown_category';
  const contextSection = context ? `Additional context from team: ${context}\n\n` : '';
  return [
    'Generate exactly one reply variant for this tweet.',
    contextSection,
    `Required strategy: ${tone}`,
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
    const parsed = JSON.parse(extractJsonObject(mocked)) as Record<string, unknown>;
    const mockText = parsed[tone];
    if (typeof mockText === 'string' && mockText.trim()) return mockText.trim();
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
