import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { callClaudeText } from "../../src/claude-sdk.js";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250514";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PIPELINE_ACTION_TYPES = {
    mentions: ["reply", "qrt", "like", "monitor", "skip"],
    network: ["reply", "qrt", "like", "monitor", "skip"],
    trends: ["qrt", "reply", "statement", "skip"],
    crisis: ["statement", "monitor", "skip"],
};
const TRENDS_CONNECTIONS = ["direct", "indirect", "stretch"];
const NETWORK_TIERS = ["S", "A", "B"];
const CRISIS_SEVERITIES = ["critical", "high", "medium"];
function loadPipelinePrompt(pipeline) {
    const promptFile = path.resolve(__dirname, `../prompts/${pipeline}.md`);
    return readFileSync(promptFile, "utf-8");
}
function extractJsonArray(raw) {
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
function parsePipelineResult(raw, pipeline) {
    const parsed = JSON.parse(extractJsonArray(raw));
    if (!Array.isArray(parsed)) {
        throw new Error("LLM response is not an array");
    }
    return parsed.map((item, index) => {
        const record = item;
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
        if (typeof actionType !== "string" || !PIPELINE_ACTION_TYPES[pipeline].includes(actionType)) {
            throw new Error(`Invalid actionType at index ${index} for pipeline ${pipeline}`);
        }
        if (typeof angle !== "string" || !angle.trim()) {
            throw new Error(`Invalid angle at index ${index}`);
        }
        // Tolerate missing/excess tones — signal still valuable without tone suggestions
        const rawTones = Array.isArray(tones) ? tones.slice(0, 3) : [];
        const parsedTones = [];
        for (let toneIndex = 0; toneIndex < rawTones.length; toneIndex++) {
            const toneRecord = rawTones[toneIndex];
            const id = toneRecord?.id;
            const label = toneRecord?.label;
            const description = toneRecord?.description;
            if (typeof id !== "string" || !id.trim())
                continue;
            if (typeof label !== "string" || !label.trim())
                continue;
            if (typeof description !== "string" || !description.trim())
                continue;
            parsedTones.push({
                id: id.trim(),
                label: label.trim(),
                description: description.trim(),
            });
        }
        if (pipeline === "trends") {
            if (typeof connection !== "string" || !TRENDS_CONNECTIONS.includes(connection)) {
                throw new Error(`Invalid connection at index ${index}`);
            }
        }
        if (pipeline === "network") {
            if (typeof accountTier !== "string" || !NETWORK_TIERS.includes(accountTier)) {
                throw new Error(`Invalid accountTier at index ${index}`);
            }
        }
        if (pipeline === "crisis") {
            if (typeof severity !== "string" || !CRISIS_SEVERITIES.includes(severity)) {
                throw new Error(`Invalid severity at index ${index}`);
            }
        }
        if (typeof reason !== "string" || !reason.trim()) {
            throw new Error(`Invalid reason at index ${index}`);
        }
        return {
            tweetId: tweetId.trim(),
            actionType: actionType,
            angle: angle.trim(),
            tones: parsedTones,
            ...(pipeline === "trends" ? { connection: connection } : {}),
            ...(pipeline === "network" ? { accountTier: accountTier } : {}),
            ...(pipeline === "crisis" ? { severity: severity } : {}),
            reason: reason.trim(),
        };
    });
}
async function callAnthropic(systemPrompt, userPrompt, model, temperature) {
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
export async function classifyForPipeline(tweets, pipeline, config) {
    if (tweets.length === 0) {
        return [];
    }
    const systemPrompt = loadPipelinePrompt(pipeline);
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
    let parsed;
    try {
        const raw = await callAnthropic(systemPrompt, basePrompt, model, temperature);
        parsed = parsePipelineResult(raw, pipeline);
    }
    catch (error) {
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
//# sourceMappingURL=classify.js.map
