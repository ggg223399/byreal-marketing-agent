import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  MessageActionRowComponentBuilder,
  TextChannel,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageType,
} from 'discord.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  formatMarketingFeedbackDigest,
  generateMarketingDraftRequest,
  getMarketingSignalById,
  getMarketingSignalDispatches,
  getMarketingSignalSummary,
  isMarketingAgentSidecarAvailable,
  logMarketingAudit,
  markMarketingSignalNotified,
  recordMarketingEmojiReaction,
  recordMarketingFeedbackEvent,
  type MarketingSignal,
  type MarketingTone as ToneItem,
} from '../sidecars/marketing-agent.js';
import {
  buildMarketingActionCardViewModel,
  buildMarketingDraftCardViewModel,
  type MarketingSignalRenderInput,
} from '../presenters/marketing-signal.js';
import { buildConfigCommand } from '../../marketing-agent/config/slash-registration.js';
import {
  getEditableConfigFileContent,
  getEditableConfigFileName,
  handleConfigView,
  handleAccountsList,
  handleAccountsAdd,
  handleAccountsRemove,
  handleGovernanceAddRole,
  handleGovernanceAddUser,
  handleGovernanceClearChannel,
  handleGovernanceList,
  handleGovernanceRemoveRole,
  handleGovernanceRemoveUser,
  handleGovernanceSetChannel,
  handleKeywordsList,
  handleKeywordsAdd,
  handleKeywordsRemove,
  getPromptContent,
  handleEditableConfigFileRollback,
  handleEditableConfigFileSet,
  handlePromptSet,
  handlePromptView,
  readGovernanceConfig,
  handleSourcesList,
  handleSourceSetMaxTweets,
  type EditableConfigFileTarget,
  type PromptTarget,
} from '../../marketing-agent/config/commands.js';
import {
  getGroupChoices,
  getHandleChoices,
  getKeywordChoices,
  getSourceChoices,
} from '../../marketing-agent/config/autocomplete.js';
import { resolveMarketingConfigDir } from '../../marketing-agent/config/runtime.js';

import { notifyLark } from '../../marketing-agent/notifications/lark.js';
export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  draftChannel?: string;
}

export function shouldMarkSignalNotifiedAfterDispatch(
  deliveredCount: number,
  failedCount: number,
): boolean {
  if (deliveredCount > 0) {
    return true;
  }

  return failedCount === 0;
}

const CONFIG_WRITE_SUBCOMMANDS = new Set([
  'accounts-add',
  'accounts-remove',
  'keywords-add',
  'keywords-remove',
  'source-set-max',
  'file-apply',
  'file-edit',
  'file-rollback',
  'yaml-apply',
  'yaml-edit',
  'yaml-rollback',
  'prompt-edit',
  'prompt-set',
]);
const CONFIG_GOVERNANCE_SUBCOMMANDS = new Set([
  'access-list',
  'access-add-user',
  'access-remove-user',
  'access-add-role',
  'access-remove-role',
  'access-set-channel',
  'access-clear-channel',
]);
const ROOT_CONFIG_ADMIN_USER_IDS = ['883365374412857404'];

function parseEnvList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function evaluateConfigCommandAccess(input: {
  subcommand: string;
  userId: string;
  channelId?: string | null;
  roleIds?: string[];
  isAdministrator?: boolean;
  canManageGuild?: boolean;
  allowedUserIds?: string[];
  allowedRoleIds?: string[];
  allowedChannelIds?: string[];
  governanceAdminUserIds?: string[];
  governanceAdminRoleIds?: string[];
}): { allowed: boolean; reason?: string } {
  const {
    userId,
    channelId,
    roleIds = [],
    isAdministrator = false,
    canManageGuild = false,
    allowedUserIds = [],
    allowedRoleIds = [],
    allowedChannelIds = [],
    governanceAdminUserIds = [],
    governanceAdminRoleIds = [],
  } = input;
  const isGovernanceCommand = CONFIG_GOVERNANCE_SUBCOMMANDS.has(
    input.subcommand,
  );
  const allAdminUserIds = Array.from(
    new Set([...ROOT_CONFIG_ADMIN_USER_IDS, ...governanceAdminUserIds]),
  );
  const hasGovernanceRole =
    governanceAdminRoleIds.length > 0 &&
    roleIds.some((roleId) => governanceAdminRoleIds.includes(roleId));

  if (
    allowedChannelIds.length > 0 &&
    (!channelId || !allowedChannelIds.includes(channelId))
  ) {
    return {
      allowed: false,
      reason: 'This command is not allowed in this channel.',
    };
  }

  if (allowedUserIds.includes(userId)) {
    if (isGovernanceCommand) {
      return {
        allowed: false,
        reason: 'Governance commands require a config admin.',
      };
    }
    return { allowed: true };
  }

  if (
    allowedRoleIds.length > 0 &&
    roleIds.some((roleId) => allowedRoleIds.includes(roleId))
  ) {
    if (isGovernanceCommand) {
      return {
        allowed: false,
        reason: 'Governance commands require a config admin.',
      };
    }
    return { allowed: true };
  }

  if (allAdminUserIds.includes(userId) || hasGovernanceRole) {
    return { allowed: true };
  }

  if (isAdministrator || canManageGuild) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: isGovernanceCommand
      ? 'Governance commands require a config admin.'
      : CONFIG_WRITE_SUBCOMMANDS.has(input.subcommand)
        ? 'Config writes require Administrator/Manage Server or an explicit allowlist.'
        : 'Config access requires Administrator/Manage Server or an explicit allowlist.',
  };
}

function collectConfigOptionValues(interaction: any): Record<string, unknown> {
  const options = interaction.options?.data;
  if (!Array.isArray(options)) {
    return {};
  }

  return Object.fromEntries(
    options
      .filter((option) => typeof option?.name === 'string')
      .map((option) => [option.name, option.value ?? null]),
  );
}

function encodePromptSource(source?: string | null): string {
  return encodeURIComponent(source ?? '');
}

function decodePromptSource(value?: string): string | undefined {
  if (!value) return undefined;
  const decoded = decodeURIComponent(value);
  return decoded || undefined;
}

function buildPromptEditModal(
  target: PromptTarget,
  currentContent: string,
  sourceName?: string,
): ModalBuilder {
  const sourceSuffix = sourceName ? `:${encodePromptSource(sourceName)}` : '';
  const modal = new ModalBuilder()
    .setCustomId(`ma_cfg_prompt_submit:${target}${sourceSuffix}`)
    .setTitle(
      target === 'source'
        ? `Edit ${sourceName}`
        : target === 'brand-context'
          ? 'Edit Brand Context'
          : `Edit ${target}`,
    );

  const promptInput = new TextInputBuilder()
    .setCustomId('prompt_content')
    .setLabel('Prompt Content')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setValue(currentContent.slice(0, 4000));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput),
  );

  return modal;
}

function buildPromptPickerMenu(configDirPath: string): StringSelectMenuBuilder {
  const sourceChoices = getSourceChoices(configDirPath, '');
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ma_cfg_prompt_pick')
    .setPlaceholder('Choose a prompt to edit')
    .addOptions(
      {
        label: 'Judge Rules',
        value: 'judge',
        description: 'Edit judge.yaml rules',
      },
      {
        label: 'Reactor Rules',
        value: 'reactor',
        description: 'Edit reactor.yaml rules',
      },
      {
        label: 'Brand Context',
        value: 'brand-context',
        description: 'Edit prompts/brand_context.md',
      },
      ...sourceChoices.map((choice) => ({
        label: `Source: ${choice.value}`,
        value: `source:${encodePromptSource(choice.value)}`,
        description: 'Edit this source prompt',
      })),
    );
  return menu;
}

async function fetchAttachmentText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: HTTP ${response.status}`);
  }
  return await response.text();
}

type DraftSignal = MarketingSignalRenderInput;

function formatToneLabel(tone: ToneItem): string {
  return (tone.label || tone.id || 'Tone').trim();
}

function parseSignalTones(signal: DraftSignal): ToneItem[] {
  const normalize = (tone: unknown): ToneItem | null => {
    if (!tone || typeof tone !== 'object') return null;
    const raw = tone as Partial<ToneItem> & { name?: string };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const labelCandidate =
      typeof raw.label === 'string'
        ? raw.label.trim()
        : typeof raw.name === 'string'
          ? raw.name.trim()
          : '';
    if (!id) return null;
    return {
      id,
      label: labelCandidate || id,
      description: typeof raw.description === 'string' ? raw.description : '',
    };
  };

  if (Array.isArray(signal.tones)) {
    return signal.tones
      .map(normalize)
      .filter((tone): tone is ToneItem => Boolean(tone));
  }
  if (typeof signal.tones === 'string') {
    try {
      const parsed = JSON.parse(signal.tones) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map(normalize)
          .filter((tone): tone is ToneItem => Boolean(tone));
      }
    } catch {}
  }
  return [];
}

function parseToneActionCustomId(
  customId: string,
): { toneId: string; signalId: number } | null {
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

function buildActionCardEmbed(signal: DraftSignal): EmbedBuilder {
  const view = buildMarketingActionCardViewModel(signal);
  const embed = new EmbedBuilder()
    .setColor(view.color)
    .setTitle(view.title)
    .setURL(view.url)
    .setDescription(view.description)
    .setFooter({ text: view.footerText })
    .setThumbnail(view.thumbnailUrl)
    .addFields(...view.fields);

  if (view.imageUrl) {
    embed.setImage(view.imageUrl);
  }

  return embed;
}

function buildDraftReplyEmbed(
  signal: DraftSignal,
  toneLabel: string,
  draftText: string,
): EmbedBuilder {
  const view = buildMarketingDraftCardViewModel(signal, toneLabel, draftText);
  return new EmbedBuilder()
    .setColor(view.color)
    .setTitle(view.title)
    .setDescription(view.description)
    .setFooter({ text: view.footerText })
    .setTimestamp(new Date())
    .setURL(view.url);
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
        const recentMsgs = await parentChannel.messages.fetch({
          after: signalMessage.id,
          limit: 5,
        });
        for (const [, msg] of recentMsgs) {
          if (msg.type === MessageType.ThreadCreated) {
            await msg.delete().catch(() => undefined);
            break;
          }
        }
      }
    } catch {}
  }

  const loadingMsg = await thread.send(
    `⏳ Generating draft with ${toneLabel}...`,
  );
  const { embed } = await generateDraft();
  await loadingMsg.edit({ content: '', embeds: [embed] });
}

function buildToneActionRow(
  tones: ToneItem[],
  signalId: number,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();

  tones.slice(0, 4).forEach((tone, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ma_tone:${tone.id}:${signalId}`)
        .setLabel(formatToneLabel(tone))
        .setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary),
    );
  });

  // Add Context button in same row
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ma_context:${signalId}`)
      .setLabel('+Context')
      .setStyle(ButtonStyle.Secondary),
  );

  return row;
}

function buildContextActionRow(
  signalId: number,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ma_context:${signalId}`)
      .setLabel('✨ Add Context')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildFeedbackSelectRow(
  signalId: number,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ma_feedback:${signalId}`)
      .setPlaceholder('📋 Signal Feedback')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('❌ Not Relevant')
          .setValue('not_relevant')
          .setDescription('Signal is not relevant to Byreal'),
        new StringSelectMenuOptionBuilder()
          .setLabel('🔄 Wrong Category')
          .setValue('wrong_category')
          .setDescription('Signal is in the wrong category'),
        new StringSelectMenuOptionBuilder()
          .setLabel('📉 Low Quality')
          .setValue('low_quality')
          .setDescription('Signal is noise / low quality'),
        new StringSelectMenuOptionBuilder()
          .setLabel('🔁 Duplicate')
          .setValue('duplicate')
          .setDescription('Already seen this signal'),
        new StringSelectMenuOptionBuilder()
          .setLabel('✅ Good Signal')
          .setValue('good_signal')
          .setDescription('Correct classification, good signal'),
      ),
  );
}

function buildProcessedSignalEmbed(
  original: EmbedBuilder,
  feedbackType: string,
  feedbackBy: string,
): EmbedBuilder {
  const data = original.data;
  const processedAt = data.timestamp ? new Date(data.timestamp) : new Date();
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`[已反馈] ${data.title || 'Signal'}`)
    .setDescription(data.description ?? null)
    .setFields(...(data.fields || []), {
      name: 'Feedback',
      value: `${feedbackType} by ${feedbackBy}`,
      inline: false,
    })
    .setFooter(data.footer ?? null)
    .setTimestamp(processedAt);
}

export class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private contextMap = new Map<
    string,
    { context: string; toneInput: string; timestamp: number }
  >();
  private trackedSignalMessageIds = new Set<string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private async handleDraftWithButtons(
    message: Message,
    signalId: number,
  ): Promise<boolean> {
    if (!(await isMarketingAgentSidecarAvailable())) {
      return false;
    }

    try {
      const signal = (await getMarketingSignalById(
        signalId,
      )) as DraftSignal | null;
      if (!signal) {
        await message.reply(
          `Signal #${signalId} not found. Use \`show signals\` to see available IDs.`,
        );
        return true;
      }

      const tones = parseSignalTones(signal);
      const toneRow =
        tones.length > 0
          ? buildToneActionRow(tones, signal.id)
          : buildContextActionRow(signal.id);
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
      // Sidecar unavailable or failed — fall through to agent
      return false;
    }
  }

  private startSignalPolling(): void {
    const POLL_INTERVAL = 30_000;

    const poll = async () => {
      if (!this.client || !this.client.isReady()) return;

      try {
        const dispatches = await getMarketingSignalDispatches(10);
        if (dispatches.length === 0) return;

        const guild = this.client.guilds.cache.first();
        if (!guild) return;

        const channels = await guild.channels.fetch();
        const findChannel = (name: string): TextChannel | undefined => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ch = channels.find(
            (c: any) => c && c.name === name && c.isTextBased(),
          );
          return ch as TextChannel | undefined;
        };

        for (const dispatch of dispatches) {
          const signal = dispatch.signal as DraftSignal;
          try {
            const targetChannels = dispatch.targetChannels;
            const deliveredChannels: string[] = [];
            const failedChannels: string[] = [];

            if (targetChannels.length === 0) {
              await markMarketingSignalNotified(signal.id);
              continue;
            }

            const embed = buildActionCardEmbed(signal);
            const tones = parseSignalTones(signal);
            const toneRow =
              tones.length > 0
                ? buildToneActionRow(tones, signal.id)
                : buildContextActionRow(signal.id);
            const feedbackRow = buildFeedbackSelectRow(signal.id);

            for (const channelName of targetChannels) {
              const ch = findChannel(channelName);
              if (!ch) {
                logger.warn(
                  { channelName, signalId: signal.id },
                  'Signal channel not found',
                );
                continue;
              }

              try {
                const components =
                  dispatch.isInteractive ||
                  channelName === 'needs-reply' ||
                  channelName === 'needs-qrt'
                    ? [toneRow, feedbackRow]
                    : [feedbackRow];

                const msg = await ch.send({ embeds: [embed], components });
                this.trackedSignalMessageIds.add(msg.id);
                deliveredChannels.push(channelName);
              } catch (err) {
                failedChannels.push(channelName);
                logger.error(
                  { err, signalId: signal.id, channelName },
                  'Failed to post signal notification to channel',
                );
              }
            }

            if (
              shouldMarkSignalNotifiedAfterDispatch(
                deliveredChannels.length,
                failedChannels.length,
              )
            ) {
              await markMarketingSignalNotified(signal.id);
            }

            logger.info(
              {
                signalId: signal.id,
                channels: targetChannels,
                deliveredChannels,
                failedChannels,
                markedNotified: shouldMarkSignalNotifiedAfterDispatch(
                  deliveredChannels.length,
                  failedChannels.length,
                ),
              },
              'Signal posted to Discord',
            );
            // Lark webhook for mention signals
            if (signal.sourceName === "direct-mentions" && process.env.LARK_MENTION_WEBHOOK_URL) {
              notifyLark(process.env.LARK_MENTION_WEBHOOK_URL, {
                id: signal.id,
                author: signal.author,
                content: signal.content,
                url: signal.url,
                pipeline: signal.pipeline,
                alertLevel: signal.alertLevel,
                suggestedAction: signal.suggestedAction,
                reason: signal.reason,
                angle: signal.angle,
                replyAngle: signal.replyAngle,
                judgeReasoning: signal.judgeReasoning,
                sourceName: signal.sourceName,
                actionType: signal.actionType,
                rawJson: signal.rawJson,
                createdAt: signal.createdAt,
              }).catch(() => {});
            }
          } catch (err) {
            logger.error(
              { err, signalId: signal.id },
              'Failed to post signal notification',
            );
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
        const summaryChannelName =
          process.env.MARKETING_AGENT_SUMMARY_CHANNEL || 'periodic-summary';

        const guild = this.client.guilds.cache.first();
        if (!guild) return;

        const channels = await guild.channels.fetch();
        const summaryChannel = channels.find(
          (c: any) => c && c.name === summaryChannelName && c.isTextBased(),
        );
        if (!summaryChannel) {
          logger.warn(
            { channel: summaryChannelName },
            'Summary channel not found',
          );
          return;
        }

        // Get signals from last 12 hours (twice daily)
        const twelveHoursAgo = Math.floor(Date.now() / 1000) - 12 * 60 * 60;
        const summary = await getMarketingSignalSummary(twelveHoursAgo);

        if (summary.totalSignals === 0) {
          await (summaryChannel as any).send(
            '📊 No signals in the last 12 hours.',
          );
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 Signal Summary - Last 12 Hours')
          .setDescription(`Total signals: ${summary.totalSignals}`)
          .addFields(
            {
              name: '🔵 Mentions',
              value: String(summary.pipelineCounts.mentions),
              inline: true,
            },
            {
              name: '🟢 Network',
              value: String(summary.pipelineCounts.network),
              inline: true,
            },
            {
              name: '🟣 Trends',
              value: String(summary.pipelineCounts.trends),
              inline: true,
            },
            {
              name: '🔴 Crisis',
              value: String(summary.pipelineCounts.crisis),
              inline: true,
            },
          )
          .setTimestamp(new Date());

        await (summaryChannel as any).send({ embeds: [embed] });
        logger.info({ count: summary.totalSignals }, 'Summary posted');
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

  private scheduleDailyJob(
    hour: number,
    minute: number,
    timezoneOffset: number,
    taskName: string,
    job: () => Promise<void>,
  ): void {
    const getNextRunDelay = (): number => {
      const now = new Date();
      const utcNow = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
      const targetNow = new Date(utcNow + timezoneOffset * 60 * 60 * 1000);
      const next = new Date(targetNow);
      next.setHours(hour, minute, 0, 0);

      if (targetNow.getTime() >= next.getTime()) {
        next.setDate(next.getDate() + 1);
      }

      return next.getTime() - targetNow.getTime();
    };

    const run = async () => {
      try {
        await job();
      } catch (err) {
        logger.error({ err, taskName }, 'Scheduled job failed');
      }

      setTimeout(run, getNextRunDelay());
    };

    const initialDelay = getNextRunDelay();
    setTimeout(run, initialDelay);
    logger.info(
      { taskName, nextRunInMs: initialDelay },
      'Daily scheduler started',
    );
  }

  private startFeedbackDigestScheduler(): void {
    const DAILY_HOUR = Number(
      process.env.MARKETING_AGENT_FEEDBACK_DIGEST_HOUR ?? '9',
    );
    const DAILY_MINUTE = Number(
      process.env.MARKETING_AGENT_FEEDBACK_DIGEST_MINUTE ?? '0',
    );
    const TIMEZONE_OFFSET = Number(
      process.env.MARKETING_AGENT_FEEDBACK_DIGEST_TZ_OFFSET ?? '8',
    );

    this.scheduleDailyJob(
      DAILY_HOUR,
      DAILY_MINUTE,
      TIMEZONE_OFFSET,
      'feedback-digest',
      async () => {
        if (!this.client || !this.client.isReady()) return;

        const channelName =
          process.env.MARKETING_AGENT_FEEDBACK_SUMMARY_CHANNEL ||
          process.env.MARKETING_AGENT_SUMMARY_CHANNEL ||
          'periodic-summary';

        const guild = this.client.guilds.cache.first();
        if (!guild) return;

        const channels = await guild.channels.fetch();
        const summaryChannel = channels.find(
          (c: any) => c && c.name === channelName && c.isTextBased(),
        );
        if (!summaryChannel) {
          logger.warn(
            { channel: channelName },
            'Feedback summary channel not found',
          );
          return;
        }

        const feedbackSummary = await formatMarketingFeedbackDigest(new Date());
        if (!feedbackSummary) {
          return;
        }

        await (summaryChannel as any).send(
          `\`\`\`\n${feedbackSummary.message}\n\`\`\``,
        );
        logger.info(
          {
            channel: channelName,
            totalFeedback: feedbackSummary.digest.totalFeedback,
          },
          'Feedback digest posted',
        );
      },
    );
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

    this.client.on(
      Events.MessageReactionAdd,
      async (reaction: any, user: any) => {
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

          const reactionResult = await recordMarketingEmojiReaction({
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
          await thread.send(reactionResult.confirmationMessage);
        } catch (err) {
          logger.error({ err }, 'Failed to process emoji reaction feedback');
        }
      },
    );

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
      // Handle /config slash command
      if (
        interaction.isChatInputCommand?.() &&
        interaction.commandName === 'config'
      ) {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const configDirPath = resolveMarketingConfigDir();
        const governance = readGovernanceConfig(configDirPath);
        const memberRoles = Array.isArray(interaction.member?.roles)
          ? interaction.member.roles
          : Array.from(interaction.member?.roles?.cache?.keys?.() ?? []);
        const memberPermissions = interaction.memberPermissions;
        const access = evaluateConfigCommandAccess({
          subcommand: sub,
          userId,
          channelId: interaction.channelId,
          roleIds: memberRoles,
          isAdministrator: Boolean(
            memberPermissions?.has?.(PermissionsBitField.Flags.Administrator),
          ),
          canManageGuild: Boolean(
            memberPermissions?.has?.(PermissionsBitField.Flags.ManageGuild),
          ),
          allowedUserIds: parseEnvList(
            process.env.DISCORD_CONFIG_ALLOWED_USER_IDS,
          ).concat(governance.allowed_user_ids),
          allowedRoleIds: parseEnvList(
            process.env.DISCORD_CONFIG_ALLOWED_ROLE_IDS,
          ).concat(governance.allowed_role_ids),
          allowedChannelIds: parseEnvList(
            process.env.DISCORD_CONFIG_ALLOWED_CHANNEL_IDS,
          ).concat(governance.allowed_channel_ids),
          governanceAdminUserIds: governance.admin_user_ids,
          governanceAdminRoleIds: governance.admin_role_ids,
        });
        let result: { success: boolean; message: string };

        if (!access.allowed) {
          await logMarketingAudit('config_access_denied', {
            userId,
            username: interaction.user?.username,
            subcommand: sub,
            channelId: interaction.channelId,
            configDir: configDirPath,
            reason: access.reason,
            options: collectConfigOptionValues(interaction),
          });
          await interaction.reply({
            content: `❌ ${access.reason}`,
            ephemeral: true,
          });
          return;
        }

        if (sub === 'prompt-edit') {
          try {
            const picker = buildPromptPickerMenu(configDirPath);
            const row =
              new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
                picker,
              );
            await interaction.reply({
              content: 'Choose which prompt to edit.',
              components: [row],
              ephemeral: true,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await interaction.reply({
              content: `❌ Error: ${msg}`,
              ephemeral: true,
            });
          }
          return;
        }

        if (sub === 'yaml-edit' || sub === 'file-edit') {
          try {
            const target = interaction.options.getString(
              'file',
              true,
            ) as EditableConfigFileTarget;
            const content = getEditableConfigFileContent(configDirPath, target);
            const fileName = getEditableConfigFileName(target);
            const file = new AttachmentBuilder(Buffer.from(content, 'utf-8'), {
              name: fileName,
            });
            await interaction.reply({
              content: `Downloaded \`${fileName}\`. Edit it locally, then upload the revised file with \`/config file-apply file:${target}\`.`,
              files: [file],
              ephemeral: true,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await interaction.reply({
              content: `❌ Error: ${msg}`,
              ephemeral: true,
            });
          }
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          switch (sub) {
            case 'view':
              result = handleConfigView(configDirPath);
              break;
            case 'accounts-list':
              result = handleAccountsList(
                configDirPath,
                interaction.options.getString('group') ?? undefined,
              );
              break;
            case 'accounts-add':
              result = handleAccountsAdd(
                configDirPath,
                interaction.options.getString('group', true),
                interaction.options.getString('handle', true),
                userId,
              );
              break;
            case 'accounts-remove':
              result = handleAccountsRemove(
                configDirPath,
                interaction.options.getString('group', true),
                interaction.options.getString('handle', true),
                userId,
              );
              break;
            case 'keywords-list':
              result = handleKeywordsList(configDirPath);
              break;
            case 'keywords-add':
              result = handleKeywordsAdd(
                configDirPath,
                interaction.options.getString('keyword', true),
                userId,
              );
              break;
            case 'keywords-remove':
              result = handleKeywordsRemove(
                configDirPath,
                interaction.options.getString('keyword', true),
                userId,
              );
              break;
            case 'sources-list':
              result = handleSourcesList(configDirPath);
              break;
            case 'source-set-max': {
              const sourceName = interaction.options.getString('source', true);
              const value = interaction.options.getInteger('value', true);
              result = handleSourceSetMaxTweets(
                configDirPath,
                sourceName,
                value,
                userId,
              );
              break;
            }
            case 'prompt-view':
              result = handlePromptView(
                configDirPath,
                interaction.options.getString('target', true) as PromptTarget,
                interaction.options.getString('source') ?? undefined,
              );
              break;
            case 'prompt-set':
              result = handlePromptSet(
                configDirPath,
                interaction.options.getString('target', true) as PromptTarget,
                interaction.options.getString('content', true),
                userId,
                interaction.options.getString('source') ?? undefined,
              );
              break;
            case 'yaml-view':
            case 'file-view': {
              const target = interaction.options.getString(
                'file',
                true,
              ) as EditableConfigFileTarget;
              const content = getEditableConfigFileContent(
                configDirPath,
                target,
              );
              const fileName = getEditableConfigFileName(target);
              const file = new AttachmentBuilder(
                Buffer.from(content, 'utf-8'),
                {
                  name: fileName,
                },
              );
              await interaction.editReply({
                content: `Full file attached: \`${fileName}\``,
                files: [file],
              });
              return;
            }
            case 'yaml-apply':
            case 'file-apply': {
              const target = interaction.options.getString(
                'file',
                true,
              ) as EditableConfigFileTarget;
              const upload = interaction.options.getAttachment('upload', true);
              const content = await fetchAttachmentText(upload.url);
              result = handleEditableConfigFileSet(
                configDirPath,
                target,
                content,
                userId,
              );
              break;
            }
            case 'yaml-rollback':
            case 'file-rollback':
              result = handleEditableConfigFileRollback(
                configDirPath,
                interaction.options.getString(
                  'file',
                  true,
                ) as EditableConfigFileTarget,
              );
              break;
            case 'access-list':
              result = handleGovernanceList(configDirPath);
              break;
            case 'access-add-user':
              result = handleGovernanceAddUser(
                configDirPath,
                interaction.options.getString('user_id', true),
                'allowed_user_ids',
              );
              break;
            case 'access-remove-user':
              result = handleGovernanceRemoveUser(
                configDirPath,
                interaction.options.getString('user_id', true),
                'allowed_user_ids',
              );
              break;
            case 'access-add-role':
              result = handleGovernanceAddRole(
                configDirPath,
                interaction.options.getString('role_id', true),
                'allowed_role_ids',
              );
              break;
            case 'access-remove-role':
              result = handleGovernanceRemoveRole(
                configDirPath,
                interaction.options.getString('role_id', true),
                'allowed_role_ids',
              );
              break;
            case 'access-set-channel':
              result = handleGovernanceSetChannel(
                configDirPath,
                interaction.options.getString('channel_id', true),
              );
              break;
            case 'access-clear-channel':
              result = handleGovernanceClearChannel(configDirPath);
              break;
            default:
              result = { success: false, message: 'Unknown subcommand.' };
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { success: false, message: `Error: ${msg}` };
        }

        const prefix = result.success ? '✅' : '❌';
        if (
          result.success &&
          (CONFIG_WRITE_SUBCOMMANDS.has(sub) ||
            CONFIG_GOVERNANCE_SUBCOMMANDS.has(sub))
        ) {
          await logMarketingAudit('config_updated', {
            userId,
            username: interaction.user?.username,
            subcommand: sub,
            channelId: interaction.channelId,
            configDir: configDirPath,
            options: collectConfigOptionValues(interaction),
          });
        }
        await interaction.editReply({ content: `${prefix} ${result.message}` });
        return;
      }

      // Handle /config autocomplete
      if (
        interaction.isAutocomplete?.() &&
        interaction.commandName === 'config'
      ) {
        const sub = interaction.options.getSubcommand();
        const focused = interaction.options.getFocused(true);
        const configDirPath = resolveMarketingConfigDir();
        const governance = readGovernanceConfig(configDirPath);
        const memberRoles = Array.isArray(interaction.member?.roles)
          ? interaction.member.roles
          : Array.from(interaction.member?.roles?.cache?.keys?.() ?? []);
        const access = evaluateConfigCommandAccess({
          subcommand: sub,
          userId: interaction.user?.id ?? '',
          channelId: interaction.channelId,
          roleIds: memberRoles,
          isAdministrator: Boolean(
            interaction.memberPermissions?.has?.(
              PermissionsBitField.Flags.Administrator,
            ),
          ),
          canManageGuild: Boolean(
            interaction.memberPermissions?.has?.(
              PermissionsBitField.Flags.ManageGuild,
            ),
          ),
          allowedUserIds: parseEnvList(
            process.env.DISCORD_CONFIG_ALLOWED_USER_IDS,
          ).concat(governance.allowed_user_ids),
          allowedRoleIds: parseEnvList(
            process.env.DISCORD_CONFIG_ALLOWED_ROLE_IDS,
          ).concat(governance.allowed_role_ids),
          allowedChannelIds: parseEnvList(
            process.env.DISCORD_CONFIG_ALLOWED_CHANNEL_IDS,
          ).concat(governance.allowed_channel_ids),
          governanceAdminUserIds: governance.admin_user_ids,
          governanceAdminRoleIds: governance.admin_role_ids,
        });
        let choices: { name: string; value: string }[] = [];

        try {
          if (!access.allowed) {
            choices = [];
          } else if (focused.name === 'group') {
            choices = getGroupChoices(configDirPath, focused.value);
          } else if (focused.name === 'handle' && sub === 'accounts-remove') {
            const group = interaction.options.getString('group') ?? '';
            choices = getHandleChoices(configDirPath, group, focused.value);
          } else if (focused.name === 'keyword') {
            choices = getKeywordChoices(configDirPath, focused.value);
          } else if (focused.name === 'source') {
            choices = getSourceChoices(configDirPath, focused.value);
          }
        } catch {
          // Silently fail autocomplete — Discord ignores errors here
        }

        await interaction.respond(choices);
        return;
      }

      if (
        !(
          interaction.isButton() ||
          interaction.isStringSelectMenu() ||
          interaction.isModalSubmit()
        )
      )
        return;

      const customId = interaction.customId as string;
      if (!customId.startsWith('ma_')) return;

      const [action, a, b] = customId.split(':');

      if (action === 'ma_tone' && interaction.isButton()) {
        const parsedToneAction = parseToneActionCustomId(customId);
        if (!parsedToneAction) {
          await interaction
            .reply({ content: '⚠️ Invalid action.', ephemeral: true })
            .catch(() => undefined);
          return;
        }

        const { toneId, signalId } = parsedToneAction;

        await interaction.deferUpdate();

        try {
          const signal = await getMarketingSignalById(signalId);
          if (!signal) {
            await interaction
              .followUp({ content: '⚠️ Signal not found', ephemeral: true })
              .catch(() => undefined);
            return;
          }

          const tones = parseSignalTones(signal);
          const tone = tones.find((item) => item.id === toneId) ??
            tones[0] ?? { id: toneId, label: toneId, description: '' };

          if (!tones.some((item) => item.id === toneId)) {
            logger.warn(
              { signalId, toneId },
              'Selected tone not found in current signal tones, falling back',
            );
          }

          const contextKey = `${interaction.user.id}:${signalId}`;
          const storedContext = this.contextMap.get(contextKey);
          const context = storedContext?.context;

          const signalMessage = interaction.message;
          await sendDraftInThread(
            signalMessage,
            signalId,
            formatToneLabel(tone),
            async () => {
              const draft = await generateMarketingDraftRequest({
                signal,
                toneId: tone.id || toneId,
                context,
              });
              if (draft.usedFallbackTone) {
                logger.warn(
                  { signalId, toneId },
                  'Selected tone not found in sidecar, using fallback',
                );
              }
              return {
                embed: buildDraftReplyEmbed(
                  signal,
                  draft.toneLabel,
                  draft.draftText,
                ),
              };
            },
          );

          if (storedContext) {
            this.contextMap.delete(contextKey);
          }
        } catch (err) {
          logger.error({ err, signalId, toneId }, 'Tone handler failed');
          await interaction
            .followUp({
              content: '⚠️ Failed to generate draft.',
              ephemeral: true,
            })
            .catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_context' && interaction.isButton()) {
        const signalId = Number(a);
        if (!Number.isFinite(signalId)) {
          await interaction
            .reply({ content: '⚠️ Invalid signal id.', ephemeral: true })
            .catch(() => undefined);
          return;
        }

        try {
          const signal = await getMarketingSignalById(signalId);
          if (!signal) {
            await interaction
              .reply({ content: '⚠️ Signal not found.', ephemeral: true })
              .catch(() => undefined);
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
            .setPlaceholder(
              modalTones
                .slice(0, 3)
                .map((t) => t.label)
                .join(' / ') || 'e.g. thoughtful / concise',
            )
            .setRequired(false);

          const contextInput = new TextInputBuilder()
            .setCustomId('context_input')
            .setLabel('Additional Context')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(
              'Any additional context for the AI when generating the reply...',
            )
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(toneInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              contextInput,
            ),
          );

          await interaction.showModal(modal);
        } catch (err) {
          logger.error({ err, signalId }, 'Context modal failed');
          await interaction
            .reply({ content: '⚠️ Failed to open modal.', ephemeral: true })
            .catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_cfg_prompt_pick' && interaction.isStringSelectMenu()) {
        const selected = interaction.values?.[0];
        if (!selected) {
          await interaction
            .reply({ content: '⚠️ Invalid prompt selection.', ephemeral: true })
            .catch(() => undefined);
          return;
        }

        try {
          const configDirPath = resolveMarketingConfigDir();
          const [rawTarget, rawSource] = selected.split(':');
          const target = rawTarget as PromptTarget;
          const sourceName =
            target === 'source' ? decodePromptSource(rawSource) : undefined;
          const currentContent = getPromptContent(
            configDirPath,
            target,
            sourceName,
          );

          if (currentContent.length > 4000) {
            await interaction.reply({
              content:
                '❌ Current prompt is longer than Discord modal limit (4000 chars). Use `/config prompt-view` and shorten it first.',
              ephemeral: true,
            });
            return;
          }

          const modal = buildPromptEditModal(
            target,
            currentContent,
            sourceName,
          );
          await interaction.showModal(modal);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction
            .reply({ content: `❌ Error: ${msg}`, ephemeral: true })
            .catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_feedback' && interaction.isStringSelectMenu()) {
        const signalId = Number(a);
        const feedbackValue = interaction.values?.[0];

        if (!Number.isFinite(signalId) || !feedbackValue) {
          await interaction
            .reply({ content: '⚠️ Invalid feedback.', ephemeral: true })
            .catch(() => undefined);
          return;
        }

        await interaction.deferUpdate();

        try {
          const signal = await getMarketingSignalById(signalId);
          if (!signal) {
            await interaction
              .followUp({ content: '⚠️ Signal not found', ephemeral: true })
              .catch(() => undefined);
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
          const feedbackBy =
            interaction.member?.displayName ||
            interaction.user.globalName ||
            interaction.user.username;
          await recordMarketingFeedbackEvent({
            signal,
            feedbackType: feedbackValue,
            feedbackBy,
          });

          const signalMessage = interaction.message;
          const existingEmbed = signalMessage?.embeds?.[0];
          if (signalMessage && existingEmbed) {
            const processedEmbed = buildProcessedSignalEmbed(
              EmbedBuilder.from(existingEmbed),
              feedbackLabel,
              feedbackBy,
            );
            await signalMessage.edit({
              embeds: [processedEmbed],
              components: [],
            });

            await signalMessage.reply(`📋 Feedback recorded: ${feedbackLabel}`);
          }
        } catch (err) {
          logger.error(
            { err, signalId, feedbackValue },
            'Feedback handler failed',
          );
          await interaction
            .followUp({
              content: '⚠️ Failed to process feedback.',
              ephemeral: true,
            })
            .catch(() => undefined);
        }
        return;
      }

      if (action === 'ma_ctx_submit' && interaction.isModalSubmit()) {
        const signalId = Number(a);
        const toneInput = interaction.fields.getTextInputValue('tone_input');
        const contextInput =
          interaction.fields.getTextInputValue('context_input');

        if (!Number.isFinite(signalId)) {
          await interaction
            .reply({ content: '⚠️ Invalid signal id.', ephemeral: true })
            .catch(() => undefined);
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const signal = await getMarketingSignalById(signalId);
          if (!signal) {
            await interaction.editReply({ content: '⚠️ Signal not found' });
            return;
          }

          const availableTones = parseSignalTones(signal);
          if (availableTones.length === 0) {
            await interaction.editReply({
              content: '⚠️ No tones available for this signal.',
            });
            return;
          }

          const preferredTone = toneInput
            ? (availableTones.find(
                (tone) =>
                  tone.label.toLowerCase().includes(toneInput.toLowerCase()) ||
                  tone.id.toLowerCase().includes(toneInput.toLowerCase()),
              ) ?? availableTones[0])
            : availableTones[0];

          const contextKey = `${interaction.user.id}:${signalId}`;
          this.contextMap.set(contextKey, {
            context: contextInput,
            toneInput,
            timestamp: Date.now(),
          });

          const signalMessage = interaction.message;
          if (!signalMessage) {
            await interaction.editReply({
              content: '⚠️ Missing source message.',
            });
            return;
          }

          await sendDraftInThread(
            signalMessage,
            signalId,
            formatToneLabel(preferredTone),
            async () => {
              const draft = await generateMarketingDraftRequest({
                signal,
                toneInput,
                context: contextInput,
              });
              return {
                embed: buildDraftReplyEmbed(
                  signal,
                  draft.toneLabel,
                  draft.draftText,
                ),
              };
            },
          );

          await interaction.deleteReply().catch(() => undefined);
        } catch (err) {
          logger.error({ err, signalId }, 'Context submit handler failed');
          await interaction.editReply({
            content: '⚠️ Failed to generate draft.',
          });
        }
        return;
      }

      if (action === 'ma_cfg_prompt_submit' && interaction.isModalSubmit()) {
        const target = a as PromptTarget;
        const sourceName = decodePromptSource(b);
        const promptContent =
          interaction.fields.getTextInputValue('prompt_content');

        await interaction.deferReply({ ephemeral: true });

        try {
          const configDirPath = resolveMarketingConfigDir();
          const governance = readGovernanceConfig(configDirPath);
          const memberRoles = Array.isArray(interaction.member?.roles)
            ? interaction.member.roles
            : Array.from(interaction.member?.roles?.cache?.keys?.() ?? []);
          const memberPermissions = interaction.memberPermissions;
          const access = evaluateConfigCommandAccess({
            subcommand: 'prompt-edit',
            userId: interaction.user.id,
            channelId: interaction.channelId,
            roleIds: memberRoles,
            isAdministrator: Boolean(
              memberPermissions?.has?.(PermissionsBitField.Flags.Administrator),
            ),
            canManageGuild: Boolean(
              memberPermissions?.has?.(PermissionsBitField.Flags.ManageGuild),
            ),
            allowedUserIds: parseEnvList(
              process.env.DISCORD_CONFIG_ALLOWED_USER_IDS,
            ).concat(governance.allowed_user_ids),
            allowedRoleIds: parseEnvList(
              process.env.DISCORD_CONFIG_ALLOWED_ROLE_IDS,
            ).concat(governance.allowed_role_ids),
            allowedChannelIds: parseEnvList(
              process.env.DISCORD_CONFIG_ALLOWED_CHANNEL_IDS,
            ).concat(governance.allowed_channel_ids),
            governanceAdminUserIds: governance.admin_user_ids,
            governanceAdminRoleIds: governance.admin_role_ids,
          });

          if (!access.allowed) {
            await interaction.editReply({ content: `❌ ${access.reason}` });
            return;
          }

          const result = handlePromptSet(
            configDirPath,
            target,
            promptContent,
            interaction.user.id,
            sourceName,
          );

          if (result.success) {
            await logMarketingAudit('config_updated', {
              userId: interaction.user.id,
              username: interaction.user?.username,
              subcommand: 'prompt-edit',
              channelId: interaction.channelId,
              configDir: configDirPath,
              options: {
                target,
                source: sourceName ?? null,
                contentLength: promptContent.length,
              },
            });
          }

          await interaction.editReply({
            content: `${result.success ? '✅' : '❌'} ${result.message}`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.editReply({ content: `❌ Error: ${msg}` });
        }
        return;
      }
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient: any) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Register /config slash command per guild for faster propagation.
        try {
          const configCmd = buildConfigCommand();
          const guilds = Array.from(readyClient.guilds.cache.values());
          await Promise.all(
            guilds.map((guild: any) =>
              guild.commands.create(configCmd.toJSON()),
            ),
          );
          logger.info(
            { guildCount: guilds.length },
            'Registered /config slash command',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to register /config slash command');
        }

        this.startSignalPolling();
        this.startSummaryScheduler();
        this.startFeedbackDigestScheduler();
        setInterval(
          () => {
            const now = Date.now();
            for (const [key, value] of this.contextMap.entries()) {
              if (now - value.timestamp > 30 * 60 * 1000) {
                this.contextMap.delete(key);
              }
            }
          },
          10 * 60 * 1000,
        );
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
