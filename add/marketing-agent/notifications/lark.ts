import { logger } from "../../src/logger.js";

export interface LarkSignalInput {
  id: number;
  author: string;
  content: string;
  url?: string;
  pipeline: string;
  alertLevel?: string;
  suggestedAction?: string;
  reason?: string;
  angle?: string;
  replyAngle?: string;
  judgeReasoning?: string;
  sourceName?: string;
  actionType?: string;
  rawJson?: string;
  createdAt?: number;
}

interface TweetMetrics {
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
}

const ALERT_TEMPLATE: Record<string, string> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  none: "grey",
};

const ALERT_EMOJI: Record<string, string> = {
  red: "🔴",
  orange: "🟠",
  yellow: "🟡",
  none: "⚪",
};

const ACTION_LABEL: Record<string, string> = {
  reply_supportive: "💬 Reply",
  qrt_positioning: "🔁 Quote RT",
  collab_opportunity: "🤝 Collab",
  like_only: "👍 Like",
  explore_signal: "🔍 Explore",
  escalate_internal: "⚡ Escalate",
  none: "— Skip",
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function parseMetrics(rawJson?: string): TweetMetrics | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    return parsed.metrics ?? parsed.metadata ?? null;
  } catch {
    return null;
  }
}

function parseTweetCreatedAt(rawJson?: string): number | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    return parsed.created_at ?? null;
  } catch {
    return null;
  }
}

function formatTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatMetrics(m: TweetMetrics): string {
  const parts: string[] = [];
  if (m.views != null) parts.push(`👁 ${m.views}`);
  if (m.likes != null) parts.push(`❤️ ${m.likes}`);
  if (m.retweets != null) parts.push(`🔁 ${m.retweets}`);
  if (m.replies != null) parts.push(`💬 ${m.replies}`);
  return parts.join("  ·  ");
}

function buildCard(signal: LarkSignalInput) {
  const al = signal.alertLevel ?? "none";
  const template = ALERT_TEMPLATE[al] ?? "grey";
  const emoji = ALERT_EMOJI[al] ?? "⚪";
  const actionLabel = ACTION_LABEL[signal.suggestedAction ?? "none"] ?? signal.suggestedAction ?? "—";
  const metrics = parseMetrics(signal.rawJson);
  const tweetTime = parseTweetCreatedAt(signal.rawJson) ?? signal.createdAt;
  const tweetContent = truncate(signal.content, 400);

  const elements: unknown[] = [];

  // 1. Tweet content
  elements.push({
    tag: "markdown",
    content: `**${signal.author}**\n${tweetContent}`,
  });

  // 2. Metrics + time
  const metaParts: string[] = [];
  if (tweetTime) metaParts.push(`🕐 ${formatTime(tweetTime)}`);
  if (metrics) {
    const metricsStr = formatMetrics(metrics);
    if (metricsStr) metaParts.push(metricsStr);
  }
  if (metaParts.length) {
    elements.push({ tag: "markdown", content: metaParts.join("  ·  ") });
  }

  elements.push({ tag: "hr" });

  // 3. Info line
  elements.push({
    tag: "markdown",
    content: `${emoji} **${al.toUpperCase()}**  ·  ${actionLabel}  ·  📡 ${signal.sourceName ?? "unknown"}`,
  });

  // 4. Judge reasoning
  if (signal.judgeReasoning) {
    elements.push({
      tag: "markdown",
      content: `> ${truncate(signal.judgeReasoning, 300)}`,
    });
  }

  // 5. Reply angle
  if (signal.replyAngle && signal.replyAngle !== signal.judgeReasoning) {
    elements.push({
      tag: "markdown",
      content: `📝 **Angle:** ${truncate(signal.replyAngle, 250)}`,
    });
  }

  // 6. Button
  if (signal.url) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "View on X ↗" },
          url: signal.url,
          type: "primary",
        },
      ],
    });
  }

  // 7. Footer
  elements.push({
    tag: "note",
    elements: [
      { tag: "plain_text", content: `Signal #${signal.id}  ·  ${signal.pipeline}` },
    ],
  });

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: `${emoji} ${signal.author}` },
        subtitle: { tag: "plain_text", content: actionLabel },
        template,
      },
      elements,
    },
  };
}

export async function notifyLark(
  webhookUrl: string,
  signal: LarkSignalInput,
): Promise<boolean> {
  try {
    const body = buildCard(signal);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text, signalId: signal.id },
        "Lark webhook returned non-OK",
      );
      return false;
    }

    const json = (await res.json()) as { code?: number; msg?: string };
    if (json.code !== 0) {
      logger.warn(
        { code: json.code, msg: json.msg, signalId: signal.id },
        "Lark webhook responded with error",
      );
      return false;
    }

    logger.info({ signalId: signal.id }, "Lark mention notification sent");
    return true;
  } catch (err) {
    logger.error({ err, signalId: signal.id }, "Failed to send Lark notification");
    return false;
  }
}
