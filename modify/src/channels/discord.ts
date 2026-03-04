import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, Message, MessageActionRowComponentBuilder, TextChannel, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageType } from 'discord.js';
import * as fs from 'fs';
import { resolve } from 'path';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import type { ActionType, Pipeline, PipelineSignal, ToneItem } from '../../marketing-agent/types/index.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  draftChannel?: string;
}

type DraftSignal = PipelineSignal & {
  tones: ToneItem[] | string;
  imageUrl?: string;
  image_url?: string;
  image?: string;
  created_at?: string;
};

function formatToneLabel(tone: ToneItem): string {
  return (tone.label || tone.id || 'Tone').trim();
}

function parseSignalTones(signal: DraftSignal): ToneItem[] {
  const normalize = (tone: unknown): ToneItem | null => {
    if (!tone || typeof tone !== 'object') return null;
    const raw = tone as Partial<ToneItem> & { name?: string };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const labelCandidate = typeof raw.label === 'string'
      ? raw.label.trim()
      : (typeof raw.name === 'string' ? raw.name.trim() : '');
    if (!id) return null;
    return {
      id,
      label: labelCandidate || id,
      description: typeof raw.description === 'string' ? raw.description : '',
    };
  };

  if (Array.isArray(signal.tones)) {
    return signal.tones.map(normalize).filter((tone): tone is ToneItem => Boolean(tone));
  }
  if (typeof signal.tones === 'string') {
    try {
      const parsed = JSON.parse(signal.tones) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(normalize).filter((tone): tone is ToneItem => Boolean(tone));
      }
    } catch {}
  }
  return [];
}

function parseToneActionCustomId(customId: string): { toneId: string; signalId: number } | null {
  const match = customId.match(/^ma_tone:(.+):(\d+)$/);
  if (!match) {
    return null;
  }

  const toneId = match[1];
  const signalId = Number(match[2]);
  if (!toneId || !Number.isFinite(signalId)) {
    return null;
  }

  return { toneId, signalId };
}

function titleCaseCategory(raw: string): string {
  return raw
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pipelineLabel(pipeline: Pipeline): string {
  if (pipeline === 'mentions') return 'Mentions';
  if (pipeline === 'network') return 'Network';
  if (pipeline === 'trends') return 'Trends';
  return 'Crisis';
}

function actionLabel(actionType: ActionType): string {
  if (actionType === 'reply') return 'Reply';
  if (actionType === 'qrt') return 'Quote Tweet';
  if (actionType === 'statement') return 'Statement';
  if (actionType === 'like') return 'Like';
  if (actionType === 'monitor') return 'Monitor';
  return 'Skip';
}

function pipelineColor(pipeline: Pipeline): number {
  if (pipeline === 'mentions') return 0x3498DB;
  if (pipeline === 'network') return 0x2ECC71;
  if (pipeline === 'trends') return 0x9B59B6;
  return 0xE74C3C;
}

function formatCount(n: number | undefined): string {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTweetTime(date: Date): string {
  const nowInShanghai = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const dateInShanghai = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const isToday = nowInShanghai.getFullYear() === dateInShanghai.getFullYear()
    && nowInShanghai.getMonth() === dateInShanghai.getMonth()
    && nowInShanghai.getDate() === dateInShanghai.getDate();
  const timeStr = date.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  if (isToday) return `Today at ${timeStr}`;
  const monthDay = date.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'short',
    day: 'numeric',
  });
  return `${monthDay} at ${timeStr}`;
}

function toDateFromUnknown(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      return new Date(asNum * 1000);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function getTweetCreatedAt(signal: DraftSignal): Date {
  if (signal.rawJson) {
    try {
      const raw = JSON.parse(signal.rawJson);
      const fromTweet = toDateFromUnknown(raw?.tweet?.created_at);
      if (fromTweet) return fromTweet;
      const fromRoot = toDateFromUnknown(raw?.created_at);
      if (fromRoot) return fromRoot;
    } catch {}
  }

  if (signal.createdAt) {
    return new Date(signal.createdAt * 1000);
  }
  if (signal.created_at) {
    return new Date(signal.created_at);
  }
  return new Date();
}

function buildActionCardEmbed(signal: DraftSignal): EmbedBuilder {
  const content = signal.content.trim();
  const maxDescLen = 3200;
  const trimmedContent = content.length > maxDescLen
    ? `${content.slice(0, maxDescLen)}…`
    : content;
  let imageUrl = signal.imageUrl || signal.image_url || signal.image;
  if (!imageUrl && signal.rawJson) {
    try {
      const rawTweet = JSON.parse(signal.rawJson);
      const metaImage = rawTweet?.metadata?.imageUrl;
      if (typeof metaImage === 'string' && metaImage.startsWith('http')) {
        imageUrl = metaImage;
      }
    } catch {}
  }
  const createdAt = getTweetCreatedAt(signal);
  const authorName = signal.author.replace(/^@/, '');
  const borderColor = pipelineColor(signal.pipeline);

  const angle = signal.angle || '';
  const reason = signal.reason || '';
  const analysis = reason ? `${angle}\n\n_${reason}_` : angle;
  const avatarUrl = `https://unavatar.io/twitter/${authorName}`;

  const description = signal.url
    ? `${trimmedContent}\n\n[View Tweet →](${signal.url})`
    : trimmedContent;



  const embed = new EmbedBuilder()
    .setColor(borderColor)
    .setTitle(`@${authorName} - ${pipelineLabel(signal.pipeline)}`)
    .setURL(signal.url || null)
    .setDescription(description)
    .setFooter({ text: `Signal #${signal.id} · ${actionLabel(signal.actionType)} • ${formatTweetTime(createdAt)}` });
  embed.setThumbnail(avatarUrl);

  // Parse metrics from rawJson
  let authorFollowers: number | undefined;
  let likes: number | undefined;
  let retweets: number | undefined;
  let replies: number | undefined;
  let views: number | undefined;
  if (signal.rawJson) {
    try {
      const raw = JSON.parse(signal.rawJson);
      const meta = raw?.metadata ?? raw?.tweet?.metadata ?? {};
      authorFollowers = typeof meta.authorFollowers === 'number' ? meta.authorFollowers : undefined;
      likes = typeof meta.likes === 'number' ? meta.likes : undefined;
      retweets = typeof meta.retweets === 'number' ? meta.retweets : undefined;
      replies = typeof meta.replies === 'number' ? meta.replies : undefined;
      views = typeof meta.views === 'number' ? meta.views : undefined;
    } catch {}
  }

  const fieldSep = '─'.repeat(32);

  // Field 1: Account info (pipeline-specific label + followers)
  let accountLabel = 'Account';
  if (signal.pipeline === 'network' && signal.accountTier) {
    accountLabel = `Account · Tier ${signal.accountTier}`;
  } else if (signal.pipeline === 'trends' && signal.connection) {
    accountLabel = `Account · ${titleCaseCategory(signal.connection)}`;
  } else if (signal.pipeline === 'crisis' && signal.severity) {
    accountLabel = `Account · ${titleCaseCategory(signal.severity)}`;
  }
  const followersValue = authorFollowers != null && authorFollowers > 0
    ? `👤 ${formatCount(authorFollowers)} followers`
    : '—';

  const engagementParts: string[] = [];
  if (views != null) engagementParts.push(`👁 ${formatCount(views)}`);
  if (likes != null) engagementParts.push(`❤️ ${formatCount(likes)}`);
  if (retweets != null) engagementParts.push(`🔁 ${formatCount(retweets)}`);
  if (replies != null) engagementParts.push(`💬 ${formatCount(replies)}`);
  const engagementValue = engagementParts.length > 0
    ? engagementParts.join(' · ')
    : '—';

  const showEngagement = true;
  const detailFields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: fieldSep, value: '\u200B', inline: false },
    { name: accountLabel, value: followersValue, inline: true },
  ];
  if (showEngagement) {
    detailFields.push({ name: 'Engagement', value: engagementValue, inline: true });
  }
  embed.addFields(detailFields);

  // Analysis section with separator
  if (analysis) {
    const maxAnalysisLen = 1000;
    const truncatedAnalysis = analysis.length > maxAnalysisLen
      ? analysis.slice(0, maxAnalysisLen - 3) + '...'
      : analysis;
    embed.addFields({ name: fieldSep, value: truncatedAnalysis, inline: false });
  }
  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  return embed;
}

function buildDraftReplyEmbed(signal: DraftSignal, toneLabel: string, draftText: string): EmbedBuilder {
  const safeDraftText = draftText.replace(/```/g, "'''").trim();
  const authorName = signal.author.replace(/^@/, '');

  // Character count for Twitter's 280 limit
  const charCount = safeDraftText.length;
  const charIndicator = charCount <= 280
    ? `✅ ${charCount}/280`
    : `⚠️ ${charCount}/280`;

  // Truncate original tweet for context (max 150 chars)
  const originalContent = signal.content.trim();
  const truncatedOriginal = originalContent.length > 150
    ? originalContent.slice(0, 147) + '...'
    : originalContent;

  const separator = '─'.repeat(32);

  // Draft text at TOP — clean, no markdown, directly copyable
  const description = [
    safeDraftText,
    '',
    separator,
    `💬 Re: @${authorName}`,
    `> ${truncatedOriginal.split('\n').join('\n> ')}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x1DA1F2)
    .setTitle(`📝 ${toneLabel}`)
    .setDescription(description)
    .setFooter({ text: `${charIndicator} · Signal #${signal.id}` })
    .setTimestamp(new Date());

  if (signal.url) {
    embed.setURL(signal.url);
  }

  return embed;
}

async function sendDraftInThread(
  signalMessage: Message,
  signalId: number,
  toneLabel: string,
  generateDraft: () => Promise<{ embed: EmbedBuilder }>,
): Promise<void> {
  let thread = signalMessage.thread;

  if (!thread) {
    thread = await signalMessage.startThread({
      name: `Draft #${signalId}`,
      autoArchiveDuration: 60,
    });

    try {
      const parentChannel = signalMessage.channel;
      if ('messages' in parentChannel) {
        const recentMsgs = await parentChannel.messages.fetch({ after: signalMessage.id, limit: 5 });
        for (const [, msg] of recentMsgs) {
          if (msg.type === MessageType.ThreadCreated) {
            await msg.delete().catch(() => undefined);
            break;
          }
        }
      }
    } catch {}
  }

  const loadingMsg = await thread.send(`⏳ Generating draft with ${toneLabel}...`);
  const { embed } = await generateDraft();
  await loadingMsg.edit({ content: '', embeds: [embed] });
}

function buildToneActionRow(tones: ToneItem[], signalId: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();

  tones.slice(0, 4).forEach((tone, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ma_tone:${tone.id}:${signalId}`)
        .setLabel(formatToneLabel(tone))
        .setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary)
    );
  });

  // Add Context button in same row
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ma_context:${signalId}`)
      .setLabel('+Context')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

function buildContextActionRow(signalId: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`ma_context:${signalId}`)
        .setLabel('✨ Add Context')
        .setStyle(ButtonStyle.Secondary)
    );
}

function buildFeedbackSelectRow(signalId: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ma_feedback:${signalId}`)
        .setPlaceholder('📋 Signal Feedback')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('❌ Not Relevant').setValue('not_relevant').setDescription('Signal is not relevant to Byreal'),
          new StringSelectMenuOptionBuilder().setLabel('🔄 Wrong Category').setValue('wrong_category').setDescription('Signal is in the wrong category'),
          new StringSelectMenuOptionBuilder().setLabel('📉 Low Quality').setValue('low_quality').setDescription('Signal is noise / low quality'),
          new StringSelectMenuOptionBuilder().setLabel('🔁 Duplicate').setValue('duplicate').setDescription('Already seen this signal'),
          new StringSelectMenuOptionBuilder().setLabel('✅ Good Signal').setValue('good_signal').setDescription('Correct classification, good signal'),
        )
    );
}

function buildProcessedSignalEmbed(original: EmbedBuilder, feedbackType: string, feedbackBy: string): EmbedBuilder {
  const data = original.data;
  const processedAt = data.timestamp ? new Date(data.timestamp) : new Date();
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`[已反馈] ${data.title || 'Signal'}`)
    .setDescription(data.description ?? null)
    .setFields(
      ...(data.fields || []),
      { name: 'Feedback', value: `${feedbackType} by ${feedbackBy}`, inline: false }
    )
    .setFooter(data.footer ?? null)
    .setTimestamp(processedAt);
}

export class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private contextMap = new Map<string, { context: string; toneInput: string; timestamp: number }>();
  private trackedSignalMessageIds = new Set<string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private async handleDraftWithButtons(message: Message, signalId: number): Promise<boolean> {
    try {
      // Dynamic imports — only works after skill is installed in NanoClaw
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [dbModule] = await Promise.all([
        import('../../marketing-agent/db/index.js') as Promise<any>,
      ]);

      const signal: DraftSignal | null = dbModule.getSignalById(signalId);
      if (!signal) {
        await message.reply(`Signal #${signalId} not found. Use \`show signals\` to see available IDs.`);
        return true;
      }

      const tones = parseSignalTones(signal);
      const toneRow = tones.length > 0 ? buildToneActionRow(tones, signal.id) : buildContextActionRow(signal.id);
      const feedbackRow = buildFeedbackSelectRow(signal.id);
      const embedVariants = [buildActionCardEmbed(signal)];

      for (const embed of embedVariants) {
        await (message.channel as TextChannel).send({
          embeds: [embed],
          components: [toneRow, feedbackRow],
        });
      }


      return true;
    } catch {
      // Marketing agent not installed or unavailable — fall through to agent
      return false;
    }
  }

  private startSignalPolling(): void {
    const POLL_INTERVAL = 30_000;

    const poll = async () => {
      if (!this.client || !this.client.isReady()) return;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [dbModule, configModule, routerModule] = await Promise.all([
          import('../../marketing-agent/db/index.js') as Promise<any>,
          import('../../marketing-agent/config/loader.js') as Promise<any>,
          import('../../marketing-agent/notifications/router.js') as Promise<any>,
        ]);

        const signals = dbModule.getUnnotifiedSignals(10) as DraftSignal[];
        if (signals.length === 0) return;

        const config = configModule.loadConfig();

        const guild = this.client.guilds.cache.first();
        if (!guild) return;

        const channels = await guild.channels.fetch();
        const findChannel = (name: string): TextChannel | undefined => {
          const ch = channels.find((c: any) => c && c.name === name && c.isTextBased());
          return ch as TextChannel | undefined;
        };

        for (const signal of signals) {
          try {
            const {
              tier: tierChannelName,
              action: actionChannelName,
              shadow: shadowChannelName,
            } = routerModule.resolveTargetChannels(signal, config);
            if (!tierChannelName) {
              dbModule.markSignalNotified(signal.id);
              continue;
            }

            let tierChannel = findChannel(tierChannelName);
            if (!tierChannel && signal.pipeline === 'trends') {
              const fallbackChannelName = config.notifications?.needsReplyChannel ?? 'needs-reply';
              tierChannel = findChannel(fallbackChannelName);
            }

            if (!tierChannel) {
              logger.warn(
                { channelName: tierChannelName, signalId: signal.id },
                'Signal notification channel not found',
              );
              continue;
            }

            const embed = buildActionCardEmbed(signal);

            if (signal.url) {
              embed.setURL(signal.url);
            }

            const needsReplyName = config.notifications?.needsReplyChannel ?? 'needs-reply';
            const tones = parseSignalTones(signal);
            const toneRow = tones.length > 0 ? buildToneActionRow(tones, signal.id) : buildContextActionRow(signal.id);
            const feedbackRow = buildFeedbackSelectRow(signal.id);
            const shouldAttachToneActions = tierChannelName === needsReplyName;
            const tierMessage = await tierChannel.send({
              embeds: [embed],
              components: shouldAttachToneActions ? [toneRow, feedbackRow] : [feedbackRow],
            });
            this.trackedSignalMessageIds.add(tierMessage.id);

            if (actionChannelName && actionChannelName !== tierChannelName) {
              const actionChannel = findChannel(actionChannelName);
              if (actionChannel) {
                const actionEmbed = EmbedBuilder.from(embed);
                if (actionChannelName === needsReplyName) {
                  actionEmbed.setColor(0x57F287);
                } else {
                  actionEmbed.setColor(0xE67E22);
                }
                if (actionChannelName === needsReplyName) {
                  const actionMessage = await actionChannel.send({ embeds: [actionEmbed], components: [toneRow, feedbackRow] });
                  this.trackedSignalMessageIds.add(actionMessage.id);
                } else {
                  const actionMessage = await actionChannel.send({ embeds: [actionEmbed], components: [feedbackRow] });
                  this.trackedSignalMessageIds.add(actionMessage.id);
                }
              }
            }

            if (
              shadowChannelName
              && shadowChannelName !== tierChannelName
              && shadowChannelName !== actionChannelName
            ) {
              const shadowChannel = findChannel(shadowChannelName);
              if (shadowChannel) {
                const shadowEmbed = EmbedBuilder.from(embed).setColor(0x5865F2);
                const shadowMessage = await shadowChannel.send({ embeds: [shadowEmbed], components: [feedbackRow] });
                this.trackedSignalMessageIds.add(shadowMessage.id);
              }
            }

            // Only mark as notified after ALL posts succeed
            dbModule.markSignalNotified(signal.id);

            logger.info(
              {
                signalId: signal.id,
                tierChannel: tierChannelName,
                actionChannel: actionChannelName || 'none',
                shadowChannel: shadowChannelName || 'none',
              },
              'Signal posted to Discord',
            );
          } catch (err) {
            logger.error({ err, signalId: signal.id }, 'Failed to post signal notification');
          }
        }
      } catch (outerErr) {
        logger.error({ err: outerErr }, 'Signal polling loop error');
      }
    };

    setTimeout(() => {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 5000);
  }

  // Task 8: Twice-daily summary at 9AM and 6PM SGT
  private startSummaryScheduler(): void {
    const SUMMARY_TARGET_HOURS = [9, 18]; // 9AM and 6PM
    const TIMEZONE_OFFSET = 8; // SGT is UTC+8

    const getNextSummaryTime = (): number => {
      const now = new Date();
      const utcNow = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
      const sgtNow = new Date(utcNow + TIMEZONE_OFFSET * 60 * 60 * 1000);
      const currentHour = sgtNow.getHours();

      for (const targetHour of SUMMARY_TARGET_HOURS) {
        if (currentHour < targetHour) {
          const next = new Date(sgtNow);
          next.setHours(targetHour, 0, 0, 0);
          return next.getTime() - sgtNow.getTime();
        }
      }
      // All targets passed today, get first target tomorrow
      const tomorrow = new Date(sgtNow);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(SUMMARY_TARGET_HOURS[0], 0, 0, 0);
      return tomorrow.getTime() - sgtNow.getTime();
    };

    const runSummary = async () => {
      if (!this.client || !this.client.isReady()) return;

      try {
        const [dbModule, configModule] = await Promise.all([
          import('../../marketing-agent/db/index.js') as Promise<any>,
          import('../../marketing-agent/config/loader.js') as Promise<any>,
        ]);

        const config = configModule.loadConfig();
        const summaryChannelName = config.notifications.summaryChannel || 'periodic-summary';

        const guild = this.client.guilds.cache.first();
        if (!guild) return;

        const channels = await guild.channels.fetch();
        const summaryChannel = channels.find((c: any) => c && c.name === summaryChannelName && c.isTextBased());
        if (!summaryChannel) {
          logger.warn({ channel: summaryChannelName }, 'Summary channel not found');
          return;
        }

        // Get signals from last 12 hours (twice daily)
        const twelveHoursAgo = Math.floor(Date.now() / 1000) - 12 * 60 * 60;
        const signals = dbModule.getSignalsSince?.(twelveHoursAgo) || [];

        if (signals.length === 0) {
          await (summaryChannel as any).send('📊 No signals in the last 12 hours.');
          return;
        }

        const tierCounts = { mentions: 0, network: 0, trends: 0, crisis: 0 };
        for (const s of signals) {
          if (s.pipeline === 'mentions') tierCounts.mentions++;
          else if (s.pipeline === 'network') tierCounts.network++;
          else if (s.pipeline === 'trends') tierCounts.trends++;
          else if (s.pipeline === 'crisis') tierCounts.crisis++;
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 Signal Summary - Last 12 Hours')
          .setDescription(`Total signals: ${signals.length}`)
          .addFields(
            { name: '🔵 Mentions', value: String(tierCounts.mentions), inline: true },
            { name: '🟢 Network', value: String(tierCounts.network), inline: true },
            { name: '🟣 Trends', value: String(tierCounts.trends), inline: true },
            { name: '🔴 Crisis', value: String(tierCounts.crisis), inline: true },
          )
          .setTimestamp(new Date());

        await (summaryChannel as any).send({ embeds: [embed] });
        logger.info({ count: signals.length }, 'Summary posted');
      } catch (err) {
        logger.error({ err }, 'Failed to post summary');
      }

      // Schedule next run
      const delay = getNextSummaryTime();
      setTimeout(runSummary, delay);
    };

    // Initial delay until next summary time
    const initialDelay = getNextSummaryTime();
    setTimeout(runSummary, initialDelay);
    logger.info({ nextSummaryInMs: initialDelay }, 'Summary scheduler started');
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.client.on(Events.MessageReactionAdd, async (reaction: any, user: any) => {
      if (user?.bot) return;

      try {
        if (reaction.partial) {
          await reaction.fetch();
        }
        const message = reaction.message as Message;
        if (!message || !this.trackedSignalMessageIds.has(message.id)) {
          return;
        }

        const emoji = reaction.emoji?.name;
        if (emoji !== '👍' && emoji !== '👎' && emoji !== '🤔') {
          return;
        }

        const [dbModule] = await Promise.all([
          import('../../marketing-agent/db/index.js') as Promise<any>,
        ]);

        dbModule.logAudit('signal_emoji_reaction', {
          messageId: message.id,
          emoji,
          userId: user.id,
          username: user.username,
          channelId: message.channelId,
        });

        let thread = message.thread;
        if (!thread) {
          thread = await message.startThread({
            name: `Signal Feedback #${message.id.slice(-6)}`,
            autoArchiveDuration: 60,
          });
        }
        await thread.send(`✅ ${user.username} reacted with ${emoji}. Feedback recorded.`);
      } catch (err) {
        logger.error({ err }, 'Failed to process emoji reaction feedback');
      }
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string | undefined;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();

          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );

        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Intercept draft reply commands BEFORE registered group check
      const draftCommandMatch = /\bdraft\s+reply\s+#?(\d+)\b/i.exec(content);
      if (draftCommandMatch) {
        const signalId = Number(draftCommandMatch[1]);
        const handled = await this.handleDraftWithButtons(message, signalId);
        if (handled) return;
      }

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err: Error) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    this.client.on(Events.InteractionCreate, async (interaction: any) => {
      if (!(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return;

      const customId = interaction.customId as string;
      if (!customId.startsWith('ma_')) return;

      const [action, a, b] = customId.split(':');

      if (action === 'ma_tone' && interaction.isButton()) {
        const parsedToneAction = parseToneActionCustomId(customId);
        if (!parsedToneAction) {
          await interaction.reply({ content: '⚠️ Invalid action.', ephemeral: true }).catch(() => undefined);
          return;
        }

        const { toneId, signalId } = parsedToneAction;

        await interaction.deferUpdate();

        try {
          const [dbModule, genModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
            import('../../marketing-agent/generator/draft.js') as Promise<any>,
          ]);

          const signal = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.followUp({ content: '⚠️ Signal not found', ephemeral: true }).catch(() => undefined);
            return;
          }

          const tones = parseSignalTones(signal);
          const tone = tones.find((item) => item.id === toneId) ?? tones[0] ?? { id: toneId, label: toneId, description: '' };

          if (!tones.some((item) => item.id === toneId)) {
            logger.warn({ signalId, toneId }, 'Selected tone not found in current signal tones, falling back');
          }

          const contextKey = `${interaction.user.id}:${signalId}`;
          const storedContext = this.contextMap.get(contextKey);
          const context = storedContext?.context;
          const toneLabel = formatToneLabel(tone);

          const signalMessage = interaction.message;
          await sendDraftInThread(signalMessage, signalId, toneLabel, async () => {
            const draftText = await genModule.generateSingleToneDraft(signal, tone.id || toneId, context);
            return { embed: buildDraftReplyEmbed(signal, toneLabel, draftText) };
          });

          if (storedContext) {
            this.contextMap.delete(contextKey);
          }
        } catch (err) {
          logger.error({ err, signalId, toneId }, 'Tone handler failed');
          await interaction.followUp({ content: '⚠️ Failed to generate draft.', ephemeral: true }).catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_context' && interaction.isButton()) {
        const signalId = Number(a);
        if (!Number.isFinite(signalId)) {
          await interaction.reply({ content: '⚠️ Invalid signal id.', ephemeral: true }).catch(() => undefined);
          return;
        }

        try {
          const [dbModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
          ]);
          const signal = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.reply({ content: '⚠️ Signal not found.', ephemeral: true }).catch(() => undefined);
            return;
          }
          const modalTones = parseSignalTones(signal);

          const modal = new ModalBuilder()
            .setCustomId(`ma_ctx_submit:${signalId}`)
            .setTitle(`Custom Context for Signal #${signalId}`);

          const toneInput = new TextInputBuilder()
            .setCustomId('tone_input')
            .setLabel('Tone (optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(modalTones.slice(0, 3).map((t) => t.label).join(' / ') || 'e.g. thoughtful / concise')
            .setRequired(false);

          const contextInput = new TextInputBuilder()
            .setCustomId('context_input')
            .setLabel('Additional Context')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Any additional context for the AI when generating the reply...')
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(toneInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(contextInput),
          );

          await interaction.showModal(modal);
        } catch (err) {
          logger.error({ err, signalId }, 'Context modal failed');
          await interaction.reply({ content: '⚠️ Failed to open modal.', ephemeral: true }).catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_feedback' && interaction.isStringSelectMenu()) {
        const signalId = Number(a);
        const feedbackValue = interaction.values?.[0];

        if (!Number.isFinite(signalId) || !feedbackValue) {
          await interaction.reply({ content: '⚠️ Invalid feedback.', ephemeral: true }).catch(() => undefined);
          return;
        }

        await interaction.deferUpdate();

        try {
          const [dbModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
          ]);

          const signal = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.followUp({ content: '⚠️ Signal not found', ephemeral: true }).catch(() => undefined);
            return;
          }

          const feedbackLabels: Record<string, string> = {
            not_relevant: '❌ Not Relevant',
            wrong_category: '🔄 Wrong Category',
            low_quality: '📉 Low Quality',
            duplicate: '🔁 Duplicate',
            good_signal: '✅ Good Signal',
          };
          const feedbackLabel = feedbackLabels[feedbackValue] || feedbackValue;

          const classificationPath = resolve(process.cwd(), 'marketing-agent/prompts/classification.md');
          try {
            let content = fs.readFileSync(classificationPath, 'utf-8');
            const timestamp = new Date().toISOString();
            const userName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;

            if (!content.includes('## Learned Corrections')) {
              content += '\n\n## Learned Corrections\n';
            }

            const snippet = signal.content.length > 100 ? `${signal.content.slice(0, 100)}...` : signal.content;
            const correction = `\n- Signal #${signalId} (category ${signal.category}): Feedback "${feedbackLabel}" by ${userName} at ${timestamp}\n  Content: "${snippet}"`;
            content += correction;

            const entries = content.match(/\n- Signal #\d+/g) || [];
            if (entries.length > 50) {
              const lines = content.split('\n');
              const headerIndex = lines.findIndex((line) => line.trim() === '## Learned Corrections');
              if (headerIndex >= 0) {
                const before = lines.slice(0, headerIndex + 1);
                const block = lines.slice(headerIndex + 1);

                const grouped: string[] = [];
                let current: string[] = [];
                for (const line of block) {
                  if (line.startsWith('- Signal #')) {
                    if (current.length > 0) grouped.push(current.join('\n'));
                    current = [line];
                  } else if (current.length > 0) {
                    current.push(line);
                  }
                }
                if (current.length > 0) grouped.push(current.join('\n'));

                const kept = grouped.slice(-50);
                content = [...before, '', ...kept.flatMap((entry) => entry.split('\n'))].join('\n');
              }
            }

            fs.writeFileSync(classificationPath, content, 'utf-8');
          } catch (fileErr) {
            logger.warn({ err: fileErr }, 'Failed to update classification.md');
          }

          const signalMessage = interaction.message;
          const existingEmbed = signalMessage?.embeds?.[0];
          if (signalMessage && existingEmbed) {
            const feedbackBy = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
            const processedEmbed = buildProcessedSignalEmbed(
              EmbedBuilder.from(existingEmbed),
              feedbackLabel,
              feedbackBy,
            );
            await signalMessage.edit({ embeds: [processedEmbed], components: [] });

            await signalMessage.reply(`📋 Feedback recorded: ${feedbackLabel}`);
          }
        } catch (err) {
          logger.error({ err, signalId, feedbackValue }, 'Feedback handler failed');
          await interaction.followUp({ content: '⚠️ Failed to process feedback.', ephemeral: true }).catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_ctx_submit' && interaction.isModalSubmit()) {
        const signalId = Number(a);
        const toneInput = interaction.fields.getTextInputValue('tone_input');
        const contextInput = interaction.fields.getTextInputValue('context_input');

        if (!Number.isFinite(signalId)) {
          await interaction.reply({ content: '⚠️ Invalid signal id.', ephemeral: true }).catch(() => undefined);
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const [dbModule, genModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
            import('../../marketing-agent/generator/draft.js') as Promise<any>,
          ]);

          const signal = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.editReply({ content: '⚠️ Signal not found' });
            return;
          }

          const availableTones = parseSignalTones(signal);
          if (availableTones.length === 0) {
            await interaction.editReply({ content: '⚠️ No tones available for this signal.' });
            return;
          }

          let toneIndex = 0;
          if (toneInput) {
            const found = availableTones.findIndex(
              (t) =>
                t.label.toLowerCase().includes(toneInput.toLowerCase())
                || t.id.toLowerCase().includes(toneInput.toLowerCase()),
            );
            if (found >= 0) toneIndex = found;
          }
          const tone = availableTones[toneIndex];
          const toneLabel = formatToneLabel(tone);

          const contextKey = `${interaction.user.id}:${signalId}`;
          this.contextMap.set(contextKey, { context: contextInput, toneInput, timestamp: Date.now() });

          const signalMessage = interaction.message;
          if (!signalMessage) {
            await interaction.editReply({ content: '⚠️ Missing source message.' });
            return;
          }

          await sendDraftInThread(signalMessage, signalId, toneLabel, async () => {
            const draftText = await genModule.generateSingleToneDraft(signal, tone.id, contextInput);
            return { embed: buildDraftReplyEmbed(signal, toneLabel, draftText) };
          });

          await interaction.deleteReply().catch(() => undefined);
        } catch (err) {
          logger.error({ err, signalId }, 'Context submit handler failed');
          await interaction.editReply({ content: '⚠️ Failed to generate draft.' });
        }
        return;
      }
    });


    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient: any) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        this.startSignalPolling();
        this.startSummaryScheduler();
        setInterval(() => {
          const now = Date.now();
          for (const [key, value] of this.contextMap.entries()) {
            if (now - value.timestamp > 30 * 60 * 1000) {
              this.contextMap.delete(key);
            }
          }
        }, 10 * 60 * 1000);
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }

      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}
