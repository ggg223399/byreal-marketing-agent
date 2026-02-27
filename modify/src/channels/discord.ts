import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, Message, MessageActionRowComponentBuilder, TextChannel, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, AnyThreadChannel } from 'discord.js';
import * as fs from 'fs';
import { resolve } from 'path';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  draftChannel?: string;
}

type ToneConfig = { id: string; label: string; emoji: string; description: string };

type DraftSignal = {
  id: number;
  author: string;
  content: string;
  url?: string;
  imageUrl?: string;
  image_url?: string;
  image?: string;
  category: number;
  confidence: number;
  relevance?: number;
  sentiment?: 'positive' | 'negative' | 'neutral';
  riskLevel?: string;
  alertLevel?: string;
  suggestedAction?: string;
  created_at?: string;
};
type SignalCategories = Record<number, string>;

const SIGNAL_CATEGORIES: SignalCategories = {
  0: '🔇 noise',
  1: '⭐ byreal_mention',
  2: '🔍 competitor_intel',
  3: '🎯 market_opportunity',
  4: '📊 defi_metrics',
  5: '🌱 ecosystem_growth',
  6: '🔮 future_sectors',
  7: '📜 rwa_signal',
  8: '⚠️ risk_event',
};

const DEFAULT_TONES: ToneConfig[] = [
  { id: 'helpful_expert', label: 'Helpful', emoji: '', description: '专业权威，提供具体价值' },
  { id: 'friendly_peer', label: 'Friendly', emoji: '', description: '轻松对等，亲切友好' },
  { id: 'humble_ack', label: 'Humble', emoji: '', description: '感恩致谢，不强推' },
  { id: 'direct_rebuttal', label: 'Direct', emoji: '', description: '正面回应关切，建设性反驳' },
];

function formatToneLabel(tone: ToneConfig): string {
  return (tone.label || tone.id || 'Tone').trim();
}

function getConfiguredTones(config: any): ToneConfig[] {
  const tones = config?.tones;
  if (Array.isArray(tones) && tones.length > 0) {
    return tones as ToneConfig[];
  }
  return DEFAULT_TONES;
}

function titleCaseCategory(raw: string): string {
  return raw
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

type SignalEmbedStyle = 'unified';

function getPriorityFromConfidence(confidence: number): string {
  if (confidence >= 80) return 'P1';
  if (confidence >= 50) return 'P2';
  return 'P3';
}

function actionLabel(action?: string): string {
  if (action === 'qrt_positioning') return '📢 Quote Tweet';
  if (action === 'reply_supportive') return '💬 Reply · Supportive';
  if (action === 'like_only') return '👍 Like Only';
  if (action === 'monitor') return '👀 Monitor';
  if (action === 'escalate_internal') return '🚨 Escalate · Internal';
  return '—';
}

function buildSignalEmbed(signal: DraftSignal, categories: SignalCategories, _style: SignalEmbedStyle = 'unified'): EmbedBuilder {
  const category = categories[signal.category] ?? `unknown_${signal.category}`;
  const rawCategory = category.includes(' ') ? category.split(' ').slice(1).join(' ') : category;
  const categoryName = titleCaseCategory(rawCategory);
  const content = signal.content.replace(/\s+/g, ' ').trim();
  const imageUrl = signal.imageUrl || signal.image_url || signal.image;
  const createdAt = signal.created_at ? new Date(signal.created_at) : new Date();
  const authorName = signal.author.replace(/^@/, '');

  const riskColors: Record<string, number> = { red: 0xf23f43, orange: 0xf0b232, yellow: 0xf0b232 };
  const borderColor = riskColors[signal.alertLevel || 'none'] ?? 0x23a559;

  const priority = getPriorityFromConfidence(signal.confidence ?? 0);
  const score = signal.confidence ?? 0;
  const risk = signal.riskLevel ? signal.riskLevel.charAt(0).toUpperCase() + signal.riskLevel.slice(1) : 'Low';
  const sentimentLabel = signal.sentiment
    ? signal.sentiment.charAt(0).toUpperCase() + signal.sentiment.slice(1)
    : 'Neutral';

  const separator = '----------------------------------------';
  const description = signal.url
    ? `${content}\n\n[View Tweet](${signal.url})\n\n${separator}`
    : `${content}\n\n${separator}`;

  const embed = new EmbedBuilder()
    .setColor(borderColor)
    .setTitle(`@${authorName} - ${categoryName}`)
    .setURL(signal.url || null)
    .setDescription(description)
    .addFields(
      { name: 'Priority · Confidence', value: `${priority} · ${score}`, inline: true },
      { name: 'Risk · Sentiment', value: `${risk} · ${sentimentLabel}`, inline: true },
      { name: 'Action', value: actionLabel(signal.suggestedAction), inline: true },
    )
    .setFooter({ text: `Signal #${signal.id}` })
    .setTimestamp(createdAt);

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  return embed;
}

function buildDraftReplyEmbed(signal: DraftSignal, toneLabel: string, draftText: string): EmbedBuilder {
  const safeDraftText = draftText.replace(/```/g, "'''").trim();
  const embed = new EmbedBuilder()
    .setColor(0x1DA1F2)
    .setAuthor({
      name: `@${signal.author}`,
      url: signal.url || undefined,
    })
    .setDescription(safeDraftText)
    .setFooter({ text: `Draft Reply · ${toneLabel} · #${signal.id}` })
    .setTimestamp(new Date());

  if (signal.url) {
    embed.setURL(signal.url);
  }

  return embed;
}

function buildToneActionRow(tones: ToneConfig[], signalId: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();

  tones.forEach((tone, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ma_tone:${i}:${signalId}`)
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

      const toneRow = buildToneActionRow(DEFAULT_TONES, signal.id);
      const feedbackRow = buildFeedbackSelectRow(signal.id);
      const embedVariants = [buildSignalEmbed(signal, SIGNAL_CATEGORIES, 'unified')];

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

        const signals = dbModule.getUnnotifiedSignals(10);
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
            const { tier: tierChannelName, action: actionChannelName } = routerModule.resolveTargetChannels(signal, config);
            const tierChannel = findChannel(tierChannelName);

            if (!tierChannel) {
              logger.warn(
                { channelName: tierChannelName, signalId: signal.id },
                'Signal notification channel not found',
              );
              continue;
            }

            const embed = buildSignalEmbed(signal, SIGNAL_CATEGORIES, 'unified');

            if (signal.url) {
              embed.setURL(signal.url);
            }

            // Post to tier channel (no action buttons - info only)
            await tierChannel.send({ embeds: [embed] });

            // If action channel exists, post with Generate Reply button (only for needs-reply)
            if (actionChannelName) {
              const actionChannel = findChannel(actionChannelName);
              if (actionChannel) {
                // Only add tone buttons for needs-reply channel; needs-interaction is info-only
                const needsReplyName = config.notifications?.needsReplyChannel ?? 'needs-reply';
                const actionEmbed = EmbedBuilder.from(embed);
                if (actionChannelName === needsReplyName) {
                  actionEmbed.setColor(0x57F287);
                } else {
                  actionEmbed.setColor(0xE67E22);
                }
                if (actionChannelName === needsReplyName) {
                  const tones = getConfiguredTones(config);
                  const toneRow = buildToneActionRow(tones, signal.id);
                  const feedbackRow = buildFeedbackSelectRow(signal.id);

                  const actionEmbeds = [actionEmbed];

                  for (const previewEmbed of actionEmbeds) {
                    await actionChannel.send({ embeds: [previewEmbed], components: [toneRow, feedbackRow] });
                  }
                } else {
                  await actionChannel.send({ embeds: [actionEmbed] });
                }
              }
            }

            // Only mark as notified after ALL posts succeed
            dbModule.markSignalNotified(signal.id);

            logger.info(
              { signalId: signal.id, tierChannel: tierChannelName, actionChannel: actionChannelName || 'none' },
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
        const [dbModule, configModule, routerModule] = await Promise.all([
          import('../../marketing-agent/db/index.js') as Promise<any>,
          import('../../marketing-agent/config/loader.js') as Promise<any>,
          import('../../marketing-agent/notifications/router.js') as Promise<any>,
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

        // Group by tier
        const tierCounts = { red: 0, orange: 0, yellow: 0, none: 0 };
        for (const s of signals) {
          if (s.alertLevel === 'red') tierCounts.red++;
          else if (s.alertLevel === 'orange') tierCounts.orange++;
          else if (s.alertLevel === 'yellow') tierCounts.yellow++;
          else tierCounts.none++;
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 Signal Summary - Last 12 Hours')
          .setDescription(`Total signals: ${signals.length}`)
          .addFields(
            { name: '🔴 Tier 1', value: String(tierCounts.red), inline: true },
            { name: '🟠 Tier 2', value: String(tierCounts.orange), inline: true },
            { name: '🟡 Tier 3', value: String(tierCounts.yellow), inline: true },
            { name: '⚪ Noise', value: String(tierCounts.none), inline: true },
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
      ],
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
        const toneIndex = Number(a);
        const signalId = Number(b);

        if (!Number.isFinite(toneIndex) || !Number.isFinite(signalId)) {
          await interaction.reply({ content: '⚠️ Invalid action.', ephemeral: true }).catch(() => undefined);
          return;
        }

        await interaction.deferUpdate();

        try {
          const [dbModule, genModule, configModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
            import('../../marketing-agent/generator/draft.js') as Promise<any>,
            import('../../marketing-agent/config/loader.js') as Promise<any>,
          ]);

          const signal = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.followUp({ content: '⚠️ Signal not found', ephemeral: true }).catch(() => undefined);
            return;
          }

          const config = configModule.loadConfig();
          const tones = getConfiguredTones(config);
          const tone = tones[toneIndex];
          if (!tone) {
            await interaction.followUp({ content: '⚠️ Invalid tone.', ephemeral: true }).catch(() => undefined);
            return;
          }

          const contextKey = `${interaction.user.id}:${signalId}`;
          const storedContext = this.contextMap.get(contextKey);
          const context = storedContext?.context;
          const toneLabel = formatToneLabel(tone);

          const signalMessage = interaction.message;
          let thread: AnyThreadChannel;
          if (signalMessage.hasThread && signalMessage.thread) {
            thread = signalMessage.thread;
          } else {
            thread = await signalMessage.startThread({
              name: `Draft — Signal #${signalId}`,
              autoArchiveDuration: 1440,
            });
          }

          const loadingMsg = await thread.send(`⏳ Generating draft with ${toneLabel}...`);
          const draftText = await genModule.generateSingleToneDraft(signal, tone.id, context);
          const draftEmbed = buildDraftReplyEmbed(signal, toneLabel, draftText);
          await loadingMsg.edit({ content: '', embeds: [draftEmbed] });

          if (storedContext) {
            this.contextMap.delete(contextKey);
          }
        } catch (err) {
          logger.error({ err, signalId, toneIndex }, 'Tone handler failed');
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
          const configModule: any = await import('../../marketing-agent/config/loader.js');
          const config = configModule.loadConfig();
          const tones = getConfiguredTones(config);

          const modal = new ModalBuilder()
            .setCustomId(`ma_ctx_submit:${signalId}`)
            .setTitle(`Custom Context for Signal #${signalId}`);

          const toneInput = new TextInputBuilder()
            .setCustomId('tone_input')
            .setLabel('Tone (optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(tones.slice(0, 3).map((t) => t.label).join(' / '))
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

            let thread: AnyThreadChannel;
            if (signalMessage.hasThread && signalMessage.thread) {
              thread = signalMessage.thread;
            } else {
              thread = await signalMessage.startThread({
                name: `Feedback — Signal #${signalId}`,
                autoArchiveDuration: 1440,
              });
            }
            await thread.send(`📋 Feedback recorded: ${feedbackLabel}`);
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
          const [dbModule, genModule, configModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
            import('../../marketing-agent/generator/draft.js') as Promise<any>,
            import('../../marketing-agent/config/loader.js') as Promise<any>,
          ]);

          const signal = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.editReply({ content: '⚠️ Signal not found' });
            return;
          }

          const config = configModule.loadConfig();
          const tones = getConfiguredTones(config);

          let toneIndex = 0;
          if (toneInput) {
            const found = tones.findIndex(
              (t) =>
                t.label.toLowerCase().includes(toneInput.toLowerCase())
                || t.id.toLowerCase().includes(toneInput.toLowerCase()),
            );
            if (found >= 0) toneIndex = found;
          }
          const tone = tones[toneIndex];
          const toneLabel = formatToneLabel(tone);

          const contextKey = `${interaction.user.id}:${signalId}`;
          this.contextMap.set(contextKey, { context: contextInput, toneInput, timestamp: Date.now() });

          const signalMessage = interaction.message;
          if (!signalMessage) {
            await interaction.editReply({ content: '⚠️ Missing source message.' });
            return;
          }

          let thread: AnyThreadChannel;
          if (signalMessage.hasThread && signalMessage.thread) {
            thread = signalMessage.thread;
          } else {
            thread = await signalMessage.startThread({
              name: `Draft — Signal #${signalId}`,
              autoArchiveDuration: 1440,
            });
          }

          const loadingMsg = await thread.send('⏳ Generating draft with context...');
          const draftText = await genModule.generateSingleToneDraft(signal, tone.id, contextInput);
          const draftEmbed = buildDraftReplyEmbed(signal, toneLabel, draftText);
          await loadingMsg.edit({ content: '', embeds: [draftEmbed] });

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
