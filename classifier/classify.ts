import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { callClaudeText } from "../lib/claude-client.js";
import type { AlertLevel, CollectorConfig, RawTweet, SignalClass } from "../types/index.js";

export interface ClassificationResult {
  tweetId: string;
  signalClass: SignalClass;
  confidence: number;
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
  if (value > 1) {
    return 1;
  }
  return value;
}

function isSignalClass(value: unknown): value is SignalClass {
  return value === "reply_needed" || value === "watch_only" || value === "ignore";
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

  return parsed.map((item, index) => {
    const record = item as Record<string, unknown>;
    const tweetId = record.tweetId;
    const signalClass = record.signalClass;
    const confidence = Number(record.confidence);
    const reason = record.reason;

    if (typeof tweetId !== "string" || !tweetId) {
      throw new Error(`Invalid tweetId at index ${index}`);
    }
    if (!isSignalClass(signalClass)) {
      throw new Error(`Invalid signalClass at index ${index}`);
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`Invalid reason at index ${index}`);
    }

    return {
      tweetId,
      signalClass,
      confidence: clampConfidence(confidence),
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

export function deriveAlertLevel(signalClass: SignalClass, confidence: number): AlertLevel {
  const normalized = clampConfidence(confidence);

  if (signalClass === "reply_needed") {
    return normalized > 0.8 ? "red" : normalized >= 0.5 ? "orange" : "none";
  }
  if (signalClass === "watch_only") {
    return "yellow";
  }
  return "none";
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

  const basePrompt = `Classify these ${tweets.length} tweets. Return JSON array with fields: tweetId, signalClass, confidence (0-1), reason.\n${tweetLines}`;
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
    const alertLevel = deriveAlertLevel(match.signalClass, match.confidence);
    return { ...match, alertLevel };
  });
}
