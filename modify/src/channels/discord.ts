import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, Message, MessageActionRowComponentBuilder, TextChannel } from 'discord.js';
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

type DraftSignal = { id: number; author: string; content: string; category: number; confidence: number };
type SignalCategories = Record<number, string>;

type ToneKey = string;

const SIGNAL_CATEGORIES: SignalCategories = {
  1: '🚀 solana_growth_milestone',
  2: '🏛️ institutional_adoption',
  3: '📜 rwa_signal',
  4: '💧 liquidity_signal',
  5: '📊 market_structure_insight',
  6: '🏆 byreal_ranking_mention',
  7: '🤝 partner_momentum',
  8: '⚠️ risk_event',
};

const DEFAULT_TONES: ToneConfig[] = [
  { id: 'helpful_expert', label: 'Helpful Expert', emoji: '🧑‍💼', description: '专业权威，提供具体价值' },
  { id: 'friendly_peer', label: 'Friendly Peer', emoji: '👋', description: '轻松对等，亲切友好' },
  { id: 'humble_ack', label: 'Humble Ack', emoji: '🙏', description: '感恩致谢，不强推' },
  { id: 'direct_rebuttal', label: 'Direct Rebuttal', emoji: '💬', description: '正面回应关切，建设性反驳' },
];

function formatToneLabel(tone: ToneConfig): string {
  const emoji = (tone.emoji || '').trim();
  const label = (tone.label || tone.id || 'Tone').trim();
  return emoji ? emoji + ' ' + label : label;
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

function buildGenerateReplyRow(signalId: number) {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('ma_generate:' + signalId)
      .setLabel('✨ Generate Reply')
      .setStyle(ButtonStyle.Success),
  );
}

function buildToneButtonRow(tones: ToneConfig[], signalId: number) {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...tones.map((tone, i) =>
      new ButtonBuilder()
        .setCustomId('ma_tone:' + i + ':' + signalId)
        .setLabel(formatToneLabel(tone))
        .setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary)
    ),
  );
}

function buildSignalSummaryEmbed(signal: DraftSignal, categories: SignalCategories): EmbedBuilder {
  const category = categories[signal.category] ?? `unknown_${signal.category}`;
  const categoryName = titleCaseCategory(category);
  const content = signal.content.replace(/\s+/g, ' ').trim().slice(0, 220);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋 Signal #${signal.id} — ${categoryName}`)
    .setDescription(`@${signal.author} · Confidence ${signal.confidence}%\n> ${content}\n\nClick Generate Reply to open an ephemeral draft.`)
    .setFooter({ text: `#${signal.id}` });
}

function buildDraftEmbed(signal: DraftSignal, toneLabel: string, draftText: string): EmbedBuilder {
  const originalContent = signal.content.replace(/\s+/g, ' ').trim().slice(0, 200);
  const safeToneLabel = toneLabel || 'Draft';
  const description =
    '**Original** (@' + signal.author + '):\n> ' + originalContent + '\n\n**Draft:**\n' + draftText + '\n\n💡 Copy and paste to Twitter';
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('📝 Draft Reply — ' + safeToneLabel)
    .setDescription(description)
    .setFooter({ text: '#' + signal.id + ' · ' + safeToneLabel })
    .setTimestamp(new Date());
}

export class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

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

      const row = buildGenerateReplyRow(signal.id);
      await (message.channel as TextChannel).send({
        embeds: [buildSignalSummaryEmbed(signal, SIGNAL_CATEGORIES)],
        components: [row],
      });

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

            const payload = routerModule.formatSignalForDiscord(signal);
            const embedData = payload.embeds[0];

            const embed = new EmbedBuilder()
              .setColor(embedData.color)
              .setTitle(embedData.title)
              .setDescription(embedData.description)
              .setFields(embedData.fields)
              .setFooter(embedData.footer)
              .setTimestamp(new Date(embedData.timestamp));

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
                  const row = buildGenerateReplyRow(signal.id);
                  await actionChannel.send({ embeds: [actionEmbed], components: [row] });
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
      if (!interaction.isButton()) return;

      const customId = interaction.customId as string;
      if (!customId.startsWith('ma_')) return;

      const [action, a, b] = customId.split(':');

      if (action === 'ma_generate') {
        const signalId = Number(a);
        if (!Number.isFinite(signalId)) {
          await interaction.reply({ content: '⚠️ Invalid signal id.', ephemeral: true }).catch(() => undefined);
          return;
        }

        await interaction.reply({ content: '✨ Generating draft...', ephemeral: true }).catch(() => undefined);

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [dbModule, genModule, configModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
            import('../../marketing-agent/generator/draft.js') as Promise<any>,
            import('../../marketing-agent/config/loader.js') as Promise<any>,
          ]);

          const signal: DraftSignal | null = dbModule.getSignalById(signalId);
          if (!signal) {
            await interaction.editReply({ content: '⚠️ Signal not found', components: [] }).catch(() => undefined);
            return;
          }

          const config = configModule.loadConfig();
          const tones = getConfiguredTones(config);
          const toneIndex = 0;
          const tone = tones[toneIndex];
          const toneLabel = formatToneLabel(tone);

          const draftText: string = await genModule.generateSingleToneDraft(signal, tone.id);
          const row = buildToneButtonRow(tones, signal.id);

          await interaction.editReply({
            content: '',
            embeds: [buildDraftEmbed(signal, toneLabel, draftText)],
            components: [row],
          }).catch(() => undefined);
        } catch (err) {
          logger.error({ err, signalId }, 'Generate Reply handler failed');
          await interaction.editReply({ content: '⚠️ Failed to generate draft. Check logs.', components: [] }).catch(() => undefined);
        }

        return;
      }

      if (action === 'ma_tone') {
        const toneKey: ToneKey | undefined = a;
        const signalId = Number(b);

        if (!toneKey || !Number.isFinite(signalId)) {
          await interaction.reply({ content: '⚠️ Invalid tone action.', ephemeral: true }).catch(() => undefined);
          return;
        }

        // If this button lives on an ephemeral interaction message, update it in-place.
        const canUpdateMessage = Boolean(interaction.message?.interaction);

        if (!canUpdateMessage) {
          await interaction.reply({ content: '✨ Generating draft...', ephemeral: true }).catch(() => undefined);
        } else {
          await interaction.deferUpdate().catch(() => undefined);
          await interaction.message.edit({ content: '✨ Generating draft...', embeds: [], components: [] }).catch(() => undefined);
        }

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [dbModule, genModule, configModule] = await Promise.all([
            import('../../marketing-agent/db/index.js') as Promise<any>,
            import('../../marketing-agent/generator/draft.js') as Promise<any>,
            import('../../marketing-agent/config/loader.js') as Promise<any>,
          ]);

          const config = configModule.loadConfig();
          const tones = getConfiguredTones(config);

          let toneIndex = Number(toneKey);
          if (!Number.isInteger(toneIndex)) {
            toneIndex = tones.findIndex((t) => t.id === toneKey);
          }

          if (toneIndex < 0 || toneIndex >= tones.length) {
            const msg = '⚠️ Unsupported tone.';
            if (canUpdateMessage) {
              await interaction.followUp({ content: msg, ephemeral: true }).catch(() => undefined);
            } else {
              await interaction.editReply({ content: msg, components: [] }).catch(() => undefined);
            }
            return;
          }

          const signal: DraftSignal | null = dbModule.getSignalById(signalId);
          if (!signal) {
            const msg = '⚠️ Signal not found';
            if (canUpdateMessage) {
              await interaction.followUp({ content: msg, ephemeral: true }).catch(() => undefined);
            } else {
              await interaction.editReply({ content: msg, components: [] }).catch(() => undefined);
            }
            return;
          }

          const tone = tones[toneIndex];
          const toneLabel = formatToneLabel(tone);
          const draftText: string = await genModule.generateSingleToneDraft(signal, tone.id);
          const row = buildToneButtonRow(tones, signal.id);

          if (canUpdateMessage) {
            await interaction.message.edit({
              content: '',
              embeds: [buildDraftEmbed(signal, toneLabel, draftText)],
              components: [row],
            }).catch(() => undefined);
          } else {
            await interaction.editReply({
              content: '',
              embeds: [buildDraftEmbed(signal, toneLabel, draftText)],
              components: [row],
            }).catch(() => undefined);
          }
        } catch (err) {
          logger.error({ err, signalId, toneKey }, 'Draft tone button handler failed');
          const msg = '⚠️ Failed to generate draft. Check logs.';
          if (canUpdateMessage) {
            await interaction.followUp({ content: msg, ephemeral: true }).catch(() => undefined);
          } else {
            await interaction.editReply({ content: msg, components: [] }).catch(() => undefined);
          }
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
