import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { buildNarrativeSummary } from "../config/loader.js";
import { callClaudeText } from "../lib/claude-client.js";
import type {
  ActionType,
  CollectorConfig,
  Pipeline,
  PipelineClassificationResult,
  RawTweet,
  ToneItem,
} from "../types/index.js";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250514";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PIPELINE_ACTION_TYPES: Record<Pipeline, ActionType[]> = {
  mentions: ["reply", "qrt", "like", "monitor", "skip"],
  network: ["reply", "qrt", "like", "monitor", "skip"],
  trends: ["qrt", "reply", "statement", "skip"],
  crisis: ["statement", "monitor", "skip"],
};

const TRENDS_CONNECTIONS = ["direct", "indirect", "stretch"] as const;
const NETWORK_TIERS = ["O", "S", "A", "B", "C"] as const;
const CRISIS_SEVERITIES = ["critical", "high", "medium"] as const;

function getAllowedNetworkActions(accountTier: (typeof NETWORK_TIERS)[number]): ActionType[] {
  if (accountTier === "B") {
    return ["monitor", "skip"];
  }
  return ["reply", "qrt", "like", "monitor", "skip"];
}

function loadPipelinePrompt(pipeline: Pipeline, tweets: RawTweet[]): string {
  const promptFile = path.resolve(__dirname, `../prompts/${pipeline}.md`);
  let prompt = readFileSync(promptFile, "utf-8");
  if (pipeline === "trends") {
    const summary = buildNarrativeSummary();
    prompt = prompt.replace("{{NARRATIVE_SUMMARY}}", summary);
  }
  if (pipeline === "network") {
    const firstTier = tweets[0]?.metadata?.accountTier;
    const resolvedTier = typeof firstTier === "string" ? firstTier : "unknown";
    prompt = prompt.replace("{{accountTier}}", resolvedTier);
  }
  return prompt;
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

function parsePipelineResult(raw: string, pipeline: Pipeline): PipelineClassificationResult[] {
  const parsed = JSON.parse(extractJsonArray(raw));
  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not an array");
  }

  return parsed.map((item, index) => {
    const record = item as Record<string, unknown>;
    const tweetId = record.tweetId;
    const actionType = record.actionType;
    const angle = record.angle;
    const tones = record.tones;
    const connection = record.connection;
    const accountTier = record.accountTier;
    const severity = record.severity;
    const reason = record.reason;

    if (typeof tweetId !== "string" || !tweetId.trim()) {
      throw new Error(`Invalid tweetId at index ${index}`);
    }
    if (typeof angle !== "string" || !angle.trim()) {
      throw new Error(`Invalid angle at index ${index}`);
    }
    // Tolerate missing/excess tones — signal still valuable without tone suggestions
    const rawTones = Array.isArray(tones) ? tones.slice(0, 3) : [];

    const parsedTones: ToneItem[] = [];
    for (let toneIndex = 0; toneIndex < rawTones.length; toneIndex++) {
      const toneRecord = rawTones[toneIndex] as Record<string, unknown>;
      const id = toneRecord?.id;
      const label = toneRecord?.label;
      const description = toneRecord?.description;

      if (typeof id !== "string" || !id.trim()) continue;
      if (typeof label !== "string" || !label.trim()) continue;
      if (typeof description !== "string" || !description.trim()) continue;

      parsedTones.push({
        id: id.trim(),
        label: label.trim(),
        description: description.trim(),
      });
    }

    if (pipeline === "trends") {
      if (typeof connection !== "string" || !TRENDS_CONNECTIONS.includes(connection as (typeof TRENDS_CONNECTIONS)[number])) {
        throw new Error(`Invalid connection at index ${index}`);
      }
    }

    if (pipeline === "network") {
      if (typeof accountTier !== "string" || !NETWORK_TIERS.includes(accountTier as (typeof NETWORK_TIERS)[number])) {
        throw new Error(`Invalid accountTier at index ${index}`);
      }

      const allowedActions = getAllowedNetworkActions(accountTier as (typeof NETWORK_TIERS)[number]);
      if (typeof actionType !== "string" || !allowedActions.includes(actionType as ActionType)) {
        throw new Error(`Invalid actionType at index ${index} for network tier ${accountTier}`);
      }
    } else if (typeof actionType !== "string" || !PIPELINE_ACTION_TYPES[pipeline].includes(actionType as ActionType)) {
      throw new Error(`Invalid actionType at index ${index} for pipeline ${pipeline}`);
    }

    if (pipeline === "crisis") {
      if (typeof severity !== "string" || !CRISIS_SEVERITIES.includes(severity as (typeof CRISIS_SEVERITIES)[number])) {
        throw new Error(`Invalid severity at index ${index}`);
      }
    }

    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`Invalid reason at index ${index}`);
    }

    return {
      tweetId: tweetId.trim(),
      actionType: actionType as ActionType,
      angle: angle.trim(),
      tones: parsedTones,
      ...(pipeline === "trends" ? { connection: connection as "direct" | "indirect" | "stretch" } : {}),
      ...(pipeline === "network" ? { accountTier: accountTier as "O" | "S" | "A" | "B" | "C" } : {}),
      ...(pipeline === "crisis" ? { severity: severity as "critical" | "high" | "medium" } : {}),
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
    maxTokens: 16384,
  });
}

export async function classifyForPipeline(
  tweets: RawTweet[],
  pipeline: Pipeline,
  config: CollectorConfig,
): Promise<PipelineClassificationResult[]> {
  if (tweets.length === 0) {
    return [];
  }

  const systemPrompt = loadPipelinePrompt(pipeline, tweets);
  const model = config.classification?.model || DEFAULT_MODEL;
  const temperature = config.classification?.temperature ?? 0;

  const tweetLines = tweets
    .map((tweet, index) => {
      const safeContent = tweet.content.replace(/\s+/g, " ").trim();
      return `[Tweet ${index + 1}] id: ${tweet.id}, author: ${tweet.author}, content: "${safeContent}"`;
    })
    .join("\n");

  const basePrompt = `Analyze these ${tweets.length} tweets for the ${pipeline} pipeline and return a valid JSON array only.\n${tweetLines}`;
  const retryPrompt = `${basePrompt}\nOnly output valid JSON. Do not include markdown fences or additional text.`;

  let parsed: PipelineClassificationResult[];
  try {
    const raw = await callAnthropic(systemPrompt, basePrompt, model, temperature);
    parsed = parsePipelineResult(raw, pipeline);
  } catch (error) {
    const rawRetry = await callAnthropic(systemPrompt, retryPrompt, model, temperature);
    parsed = parsePipelineResult(rawRetry, pipeline);
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
    return match;
  });
}
