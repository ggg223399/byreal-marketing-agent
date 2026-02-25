import { callClaudeText } from '../lib/claude-client.js';
import type { DraftReply, DraftVariant, Signal } from '../types/index.js';

const MODEL = 'claude-3-5-haiku-20241022';
const TEMPERATURE = 0.7;

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
  const professional = parsed.professional;
  const friendly = parsed.friendly;

  if (typeof professional !== 'string' || !professional.trim()) {
    throw new Error('Missing professional draft');
  }
  if (typeof friendly !== 'string' || !friendly.trim()) {
    throw new Error('Missing friendly draft');
  }

  return [
    { tone: 'professional', text: professional.trim() },
    { tone: 'friendly', text: friendly.trim() },
  ];
}

function buildSystemPrompt(): string {
  return [
    'You write social replies for Byreal.',
    'Produce concise, brand-safe, positive replies.',
    'Do not overpromise. Do not mention private or unverifiable facts.',
    'Return strict JSON only.',
  ].join(' ');
}

function buildUserPrompt(signal: Signal): string {
  return [
    'Generate exactly two variants for this tweet signal.',
    `Author: ${signal.author}`,
    `Signal class: ${signal.signalClass}`,
    `Tweet: ${signal.content}`,
    'Output JSON object with keys:',
    '{"professional":"...","friendly":"..."}',
  ].join('\n');
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

  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    return {
      signalId: signal.id,
      variants: [
        {
          tone: 'professional',
          text: `Appreciate the mention, ${signal.author}. We are focused on practical execution and measurable liquidity outcomes.`,
        },
        {
          tone: 'friendly',
          text: `Thanks for the shoutout, ${signal.author}! Excited to keep building with the ecosystem.`,
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
      maxTokens: 1000,
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
      maxTokens: 1000,
    });

    return {
      signalId: signal.id,
      variants: parseVariants(retryRaw),
      generatedAt: Math.floor(Date.now() / 1000),
    };
  }
}
