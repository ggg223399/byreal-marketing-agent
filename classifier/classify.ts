import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { callClaudeText } from "../lib/claude-client.js";
import { CATEGORY_BY_NAME, SIGNAL_CATEGORIES } from "../types/index.js";
import type {
  AlertLevel,
  CollectorConfig,
  RawTweet,
  RiskLevel,
  Sentiment,
  SignalCategory,
  SuggestedAction,
} from "../types/index.js";

export interface ClassificationResult {
  tweetId: string;
  category: SignalCategory;
  confidence: number;
  sentiment: Sentiment;
  priority: number;
  riskLevel: RiskLevel;
  suggestedAction: SuggestedAction;
  alertLevel: AlertLevel;
  reason: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadRules(): string {
  return readFileSync(path.resolve(__dirname, "../prompts/classification.md"), "utf-8");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Math.round(value);
}

function isValidCategory(value: unknown): value is SignalCategory {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return false;
  }

  return value >= 1 && value <= 8 && value in SIGNAL_CATEGORIES;
}

function isSentiment(value: unknown): value is Sentiment {
  return ['positive', 'neutral', 'negative'].includes(value as string);
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return ['low', 'medium', 'high'].includes(value as string);
}

function isSuggestedAction(value: unknown): value is SuggestedAction {
  return ['qrt_positioning', 'reply_supportive', 'like_only', 'monitor', 'escalate_internal'].includes(value as string);
}

function normalizePriority(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 3;
  }
  const rounded = Math.round(numeric);
  if (rounded < 1) {
    return 1;
  }
  if (rounded > 5) {
    return 5;
  }
  return rounded;
}

function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response does not contain a JSON array");
  }
  return trimmed.slice(start, end + 1);
}

function parseAndValidate(raw: string): Array<Omit<ClassificationResult, "alertLevel">> {
  const parsed = JSON.parse(extractJsonArray(raw));
  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not an array");
  }

  const allowedCategoryNames = Object.keys(CATEGORY_BY_NAME).join(", ");

  return parsed.map((item, index) => {
    const record = item as Record<string, unknown>;
    const tweetId = record.tweetId;
    const category = Number(record.category);
    const confidence = Number(record.confidence);
    const sentiment = record.sentiment;
    const priority = record.priority;
    const riskLevel = record.riskLevel;
    const suggestedAction = record.suggestedAction;
    const reason = record.reason;

    if (typeof tweetId !== "string" || !tweetId) {
      throw new Error(`Invalid tweetId at index ${index}`);
    }
    if (!isValidCategory(category)) {
      throw new Error(`Invalid category at index ${index}. Expected integer 1-8 (${allowedCategoryNames})`);
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`Invalid reason at index ${index}`);
    }
    if (!isSentiment(sentiment)) {
      throw new Error(`Invalid sentiment at index ${index}`);
    }
    if (!isRiskLevel(riskLevel)) {
      throw new Error(`Invalid riskLevel at index ${index}`);
    }
    if (!isSuggestedAction(suggestedAction)) {
      throw new Error(`Invalid suggestedAction at index ${index}`);
    }

    return {
      tweetId,
      category,
      confidence: clampConfidence(confidence),
      sentiment,
      priority: normalizePriority(priority),
      riskLevel,
      suggestedAction,
      reason: reason.trim(),
    };
  });
}

async function callAnthropic(systemPrompt: string, userPrompt: string, model: string, temperature: number): Promise<string> {
  const mockedResponse = process.env.MOCK_CLASSIFICATION_RESPONSE;
  if (mockedResponse) {
    return mockedResponse;
  }

  return callClaudeText({
    systemPrompt,
    userPrompt,
    model,
    temperature,
    maxTokens: 4096,
  });
}

export function deriveAlertLevel(category: SignalCategory, confidence: number): AlertLevel {
  const normalized = clampConfidence(confidence);

  if (category === 8) {
    return 'red';
  }

  if (category === 1) {
    return normalized > 80 ? 'red' : 'yellow';
  }

  if (category === 6) {
    if (normalized > 80) {
      return 'red';
    }
    if (normalized >= 50) {
      return 'orange';
    }
    return 'none';
  }

  if (category === 2 || category === 5) {
    return normalized >= 50 ? 'orange' : 'none';
  }

  if (category === 3 || category === 4 || category === 7) {
    return 'yellow';
  }

  return 'none';
}

export async function classifyTweets(
  tweets: RawTweet[],
  config: CollectorConfig
): Promise<ClassificationResult[]> {
  if (tweets.length === 0) {
    return [];
  }

  const systemPrompt = loadRules();
  const model = config.classification?.model || DEFAULT_MODEL;
  const temperature = config.classification?.temperature ?? 0;

  const tweetLines = tweets
    .map((tweet, index) => {
      const safeContent = tweet.content.replace(/\s+/g, " ").trim();
      return `[Tweet ${index + 1}] id: ${tweet.id}, author: ${tweet.author}, content: "${safeContent}"`;
    })
    .join("\n");

  const basePrompt = `Classify these ${tweets.length} tweets. Return JSON array with fields: tweetId, category (1-8), confidence (0-100), sentiment, priority (1-5), riskLevel, suggestedAction, reason.\n${tweetLines}`;
  const retryPrompt = `${basePrompt}\nOnly output valid JSON. Do not include markdown fences or additional text.`;

  let parsed: Array<Omit<ClassificationResult, "alertLevel">>;
  try {
    const raw = await callAnthropic(systemPrompt, basePrompt, model, temperature);
    parsed = parseAndValidate(raw);
  } catch (error) {
    const rawRetry = await callAnthropic(systemPrompt, retryPrompt, model, temperature);
    parsed = parseAndValidate(rawRetry);
    if (!parsed.length && error instanceof Error) {
      throw error;
    }
  }

  const byTweetId = new Map(parsed.map((item) => [item.tweetId, item]));

  return tweets.map((tweet) => {
    const match = byTweetId.get(tweet.id);
    if (!match) {
      throw new Error(`Missing classification for tweet ${tweet.id}`);
    }
    const alertLevel = deriveAlertLevel(match.category, match.confidence);
    return { ...match, alertLevel };
  });
}
