#!/usr/bin/env tsx
/**
 * Test Signal Injector
 * Inserts test signals into the DB for the marketing bot to pick up
 *
 * Usage:
 *   npx tsx marketing-agent/scripts/test-signal.ts
 *   npx tsx marketing-agent/scripts/test-signal.ts --pipeline mentions --action reply
 *   npx tsx marketing-agent/scripts/test-signal.ts --content "Custom tweet text"
 *   npx tsx marketing-agent/scripts/test-signal.ts --reset 123
 *   npx tsx marketing-agent/scripts/test-signal.ts --reset-all
 */

import { getDb, insertSignal, closeDb, getSignalsByPipeline } from '../db/index.js';
import type { Pipeline, ActionType, ToneItem } from '../types/index.js';

type PipelineType = 'mentions' | 'network' | 'trends' | 'crisis';
type ActionTypeEnum = 'reply' | 'qrt' | 'like' | 'monitor' | 'skip' | 'statement';

// Hardcoded realistic test tweets about Solana/DeFi/RWA
const TEST_TWEETS = [
  {
    content: "🚀 Solana just hit a new milestone! 65,000 TPS sustained throughput. This is what true scalability looks like. #Solana #DeFi",
    pipeline: 'mentions' as PipelineType,
    actionType: 'reply' as ActionTypeEnum,
    angle: 'Celebrate the achievement',
    tones: [
      { id: 'grateful_shoutout', label: 'Grateful Shoutout', description: 'Thank them warmly for mentioning us' },
      { id: 'friendly_peer', label: 'Friendly Peer', description: 'Casual equal-to-equal engagement' },
      { id: 'helpful_expert', label: 'Helpful Expert', description: "Add value with expertise" },
    ],
  },
  {
    content: "RWA (Real World Assets) on Solana are exploding. Tokenized treasury bills, real estate, commodities - all on-chain. The future is here. #RWA #Solana",
    pipeline: 'trends' as PipelineType,
    actionType: 'qrt' as ActionTypeEnum,
    angle: 'Share the emerging trend',
    tones: [
      { id: 'industry_analyst', label: 'Industry Analyst', description: 'Data-driven trend commentary' },
      { id: 'visionary', label: 'Visionary', description: 'Connect trend to bigger picture' },
      { id: 'educator', label: 'Educator', description: 'Explain what this means for the ecosystem' },
    ],
  },
  {
    content: "Jupiter Exchange announces new perpetual futures features. Solana's DeFi ecosystem keeps getting stronger. Trade with sub-second finality. #Jupiter #DeFi",
    pipeline: 'network' as PipelineType,
    actionType: 'reply' as ActionTypeEnum,
    angle: 'Engage with partner update',
    tones: [
      { id: 'supportive_ally', label: 'Supportive Ally', description: 'Cheer on the partner ecosystem' },
      { id: 'thought_leader', label: 'Thought Leader', description: 'Share insight on their update' },
      { id: 'collaborative', label: 'Collaborative', description: 'Suggest working together' },
    ],
  },
  {
    content: "Breakpoint 2024 announcement: PayPal USD (PYUSD) launching natively on Solana. This is massive for payments and DeFi adoption. #PYUSD #Breakpoint",
    pipeline: 'mentions' as PipelineType,
    actionType: 'reply' as ActionTypeEnum,
    angle: 'Highlight the partnership',
    tones: [
      { id: 'grateful_shoutout', label: 'Grateful Shoutout', description: 'Thank them warmly for mentioning us' },
      { id: 'friendly_peer', label: 'Friendly Peer', description: 'Casual equal-to-equal engagement' },
      { id: 'helpful_expert', label: 'Helpful Expert', description: "Add value with expertise" },
    ],
  },
  {
    content: "Marinade Finance hits 10M SOL staked. Liquid staking on Solana continues to dominate. mSOL everywhere you look! #Marinade #Staking",
    pipeline: 'network' as PipelineType,
    actionType: 'like' as ActionTypeEnum,
    angle: 'Show appreciation for milestone',
    tones: [
      { id: 'supportive_ally', label: 'Supportive Ally', description: 'Cheer on the partner ecosystem' },
      { id: 'thought_leader', label: 'Thought Leader', description: 'Share insight on their update' },
      { id: 'collaborative', label: 'Collaborative', description: 'Suggest working together' },
    ],
  },
  {
    content: "New report: Solana NFTs seeing 40% QoQ growth in active traders. The ecosystem is far from dead - it's evolving. #SolanaNFTs #Web3",
    pipeline: 'trends' as PipelineType,
    actionType: 'qrt' as ActionTypeEnum,
    angle: 'Share positive market data',
    tones: [
      { id: 'industry_analyst', label: 'Industry Analyst', description: 'Data-driven trend commentary' },
      { id: 'visionary', label: 'Visionary', description: 'Connect trend to bigger picture' },
      { id: 'educator', label: 'Educator', description: 'Explain what this means for the ecosystem' },
    ],
  },
  {
    content: "Helius raises Series A to supercharge Solana infrastructure. Better RPCs = better dev experience. Bullish on tooling. #Helius #Infra",
    pipeline: 'mentions' as PipelineType,
    actionType: 'reply' as ActionTypeEnum,
    angle: 'Congratulate the team',
    tones: [
      { id: 'grateful_shoutout', label: 'Grateful Shoutout', description: 'Thank them warmly for mentioning us' },
      { id: 'friendly_peer', label: 'Friendly Peer', description: 'Casual equal-to-equal engagement' },
      { id: 'helpful_expert', label: 'Helpful Expert', description: "Add value with expertise" },
    ],
  },
  {
    content: "Drift Protocol v2 goes live with cross-collateral and new perp markets. Solana perp DEX wars heating up. Trade responsibly! #Drift #Perps",
    pipeline: 'network' as PipelineType,
    actionType: 'monitor' as ActionTypeEnum,
    angle: 'Track new feature rollout',
    tones: [
      { id: 'supportive_ally', label: 'Supportive Ally', description: 'Cheer on the partner ecosystem' },
      { id: 'thought_leader', label: 'Thought Leader', description: 'Share insight on their update' },
      { id: 'collaborative', label: 'Collaborative', description: 'Suggest working together' },
    ],
  },
];

interface CliArgs {
  pipeline?: PipelineType;
  action?: ActionTypeEnum;
  content?: string;
  reset?: number;
  resetAll: boolean;
}

const VALID_PIPELINES: PipelineType[] = ['mentions', 'network', 'trends', 'crisis'];
const VALID_ACTIONS: ActionTypeEnum[] = ['reply', 'qrt', 'like', 'monitor', 'skip', 'statement'];

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { resetAll: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pipeline':
        const pipeline = args[++i] as PipelineType;
        if (!VALID_PIPELINES.includes(pipeline)) {
          console.error('Pipeline must be one of: ' + VALID_PIPELINES.join(', '));
          process.exit(1);
        }
        result.pipeline = pipeline;
        break;
      case '--action':
        const action = args[++i] as ActionTypeEnum;
        if (!VALID_ACTIONS.includes(action)) {
          console.error('Action must be one of: ' + VALID_ACTIONS.join(', '));
          process.exit(1);
        }
        result.action = action;
        break;
      case '--content':
        result.content = args[++i];
        break;
      case '--reset':
        result.reset = parseInt(args[++i], 10);
        break;
      case '--reset-all':
        result.resetAll = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Test Signal Injector for Marketing Agent

Usage:
  npx tsx marketing-agent/scripts/test-signal.ts                              Insert a random test signal
  npx tsx marketing-agent/scripts/test-signal.ts --pipeline mentions           Use specific pipeline (mentions, network, trends, crisis)
  npx tsx marketing-agent/scripts/test-signal.ts --action reply              Use specific action (reply, qrt, like, monitor, skip, statement)
  npx tsx marketing-agent/scripts/test-signal.ts --pipeline mentions --action reply  Use both pipeline and action
  npx tsx marketing-agent/scripts/test-signal.ts --content "Text"            Custom tweet content
  npx tsx marketing-agent/scripts/test-signal.ts --reset 123                Re-trigger signal #123
  npx tsx marketing-agent/scripts/test-signal.ts --reset-all                 Re-trigger all signals

Options:
  --pipeline <name>   Pipeline: mentions, network, trends, crisis (default: random)
  --action <type>    Action: reply, qrt, like, monitor, skip, statement (default: varies by pipeline)
  --content <text>   Custom tweet content (default: random test tweet)
  --reset <id>       Reset notified_at to NULL for specific signal ID
  --reset-all        Reset notified_at to NULL for ALL signals
  --help, -h         Show this help message
`);
        process.exit(0);
    }
  }

  return result;
}

function getDefaultAction(pipeline: PipelineType): ActionTypeEnum {
  switch (pipeline) {
    case 'mentions':
    case 'network':
      return 'reply';
    case 'trends':
      return 'qrt';
    case 'crisis':
      return 'statement';
    default:
      return 'reply';
  }
}

function getRandomTestTweet(): { content: string; pipeline: PipelineType; actionType: ActionTypeEnum; angle: string; tones: ToneItem[] } {
  const tweet = TEST_TWEETS[Math.floor(Math.random() * TEST_TWEETS.length)];
  return {
    ...tweet,
    tones: tweet.tones as ToneItem[],
  };
}

function main(): void {
  const args = parseArgs();

  // Initialize DB (ensures schema is created)
  const db = getDb();

  try {
    // Handle reset modes first
    if (args.reset !== undefined) {
      // Check if signal exists by scanning all pipelines
      let signal: { id: number } | undefined;
      const pipelines: Pipeline[] = ['mentions', 'network', 'trends', 'crisis'];
      
      for (const p of pipelines) {
        const signals = getSignalsByPipeline(p, 1000);
        const found = signals.find(s => s.id === args.reset);
        if (found) {
          signal = found;
          break;
        }
      }
      
      if (signal) {
        // Manually update notified_at to NULL
        db.prepare('UPDATE signals SET notified_at = NULL WHERE id = ?').run(args.reset);
        console.log('Signal #' + args.reset + ' reset. Bot will post it within 30s.');
      } else {
        console.error('Signal #' + args.reset + ' not found.');
        process.exit(1);
      }
      return;
    }

    if (args.resetAll) {
      const result = db.prepare('UPDATE signals SET notified_at = NULL').run();
      console.log(result.changes + ' signals reset. Bot will post them within 30s.');
      return;
    }

    // Determine tweet content and pipeline
    let content: string;
    let pipeline: Pipeline;
    let actionType: ActionType;
    let angle: string;
    let tones: ToneItem[];

    if (args.content) {
      content = args.content;
      pipeline = args.pipeline ?? 'mentions';
      actionType = args.action ?? getDefaultAction(pipeline);
      angle = 'Test engagement';
    tones = [
      { id: 'grateful_shoutout', label: 'Grateful Shoutout', description: 'Thank them warmly for mentioning us' },
      { id: 'friendly_peer', label: 'Friendly Peer', description: 'Casual equal-to-equal engagement' },
      { id: 'helpful_expert', label: 'Helpful Expert', description: "Add value with expertise" },
    ];
    } else {
      const tweet = getRandomTestTweet();
      content = tweet.content;
      pipeline = args.pipeline ?? tweet.pipeline;
      actionType = args.action ?? tweet.actionType;
      angle = tweet.angle;
      tones = tweet.tones;
    }

    // Generate a unique tweet_id (timestamp-based to avoid collisions)
    const tweetId = 'test_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const author = 'test_user';
    const url = 'https://x.com/test_user/status/' + tweetId;
    const sourceAdapter = 'test_injector';
    const reason = '';

    // Prepare raw JSON
    const rawJson = JSON.stringify({
      id: tweetId,
      author: '@' + author,
      content,
      url,
      created_at: Math.floor(Date.now() / 1000),
      metadata: {
        retweetCount: Math.floor(Math.random() * 100),
        replyCount: Math.floor(Math.random() * 50),
        likeCount: Math.floor(Math.random() * 200),
        quoteCount: Math.floor(Math.random() * 20),
        viewCount: Math.floor(Math.random() * 5000) + 1000,
        lang: 'en',
      },
      _test: true,
      _injected_at: new Date().toISOString(),
    });

    // Insert the signal using the db module (ensures schema is used)
    const signal = insertSignal({
      tweetId,
      author: '@' + author,
      content,
      url,
      pipeline,
      actionType,
      angle,
      tones,
      reason,
      sourceAdapter,
      rawJson,
    });

    console.log('\n✅ Test signal #' + signal.id + ' inserted!' +
      '\n   Pipeline: ' + pipeline +
      '\n   Action: ' + actionType +
      '\n   Author: @' + author +
      '\n   Content: "' + content.substring(0, 60) + '..."' +
      '\n   Angle: ' + angle +
      '\n   Tones: ' + tones.map(t => t.label).join(', ') +
      '\n\n🤖 Bot will post it to Discord within 30s.\n');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
