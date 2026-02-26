#!/usr/bin/env tsx
/**
 * Test Signal Injector
 * Inserts test signals into the DB for the marketing bot to pick up
 *
 * Usage:
 *   npx tsx marketing-agent/scripts/test-signal.ts
 *   npx tsx marketing-agent/scripts/test-signal.ts --category 3
 *   npx tsx marketing-agent/scripts/test-signal.ts --content "Custom tweet text"
 *   npx tsx marketing-agent/scripts/test-signal.ts --action reply_supportive
 *   npx tsx marketing-agent/scripts/test-signal.ts --reset 123
 *   npx tsx marketing-agent/scripts/test-signal.ts --reset-all
 */

import Database from 'better-sqlite3';
import { join } from 'path';

// Hardcoded realistic test tweets about Solana/DeFi/RWA
const TEST_TWEETS = [
  {
    content: "🚀 Solana just hit a new milestone! 65,000 TPS sustained throughput. This is what true scalability looks like. #Solana #DeFi",
    category: 1,
  },
  {
    content: "RWA (Real World Assets) on Solana are exploding. Tokenized treasury bills, real estate, commodities - all on-chain. The future is here. #RWA #Solana",
    category: 2,
  },
  {
    content: "Jupiter Exchange announces new perpetual futures features. Solana's DeFi ecosystem keeps getting stronger. Trade with sub-second finality. #Jupiter #DeFi",
    category: 3,
  },
  {
    content: "Breakpoint 2024 announcement: PayPal USD (PYUSD) launching natively on Solana. This is massive for payments and DeFi adoption. #PYUSD #Breakpoint",
    category: 4,
  },
  {
    content: "Marinade Finance hits 10M SOL staked. Liquid staking on Solana continues to dominate. mSOL everywhere you look! #Marinade #Staking",
    category: 5,
  },
  {
    content: "New report: Solana NFTs seeing 40% QoQ growth in active traders. The ecosystem is far from dead - it's evolving. #SolanaNFTs #Web3",
    category: 6,
  },
  {
    content: "Helius raises Series A to supercharge Solana infrastructure. Better RPCs = better dev experience. Bullish on tooling. #Helius #Infra",
    category: 7,
  },
  {
    content: "Drift Protocol v2 goes live with cross-collateral and new perp markets. Solana perp DEX wars heating up. Trade responsibly! #Drift #Perps",
    category: 8,
  },
];

interface CliArgs {
  category?: number;
  content?: string;
  action?: string;
  reset?: number;
  resetAll: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { resetAll: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--category':
        result.category = parseInt(args[++i], 10);
        if (result.category < 1 || result.category > 8) {
          console.error('❌ Category must be between 1-8');
          process.exit(1);
        }
        break;
      case '--content':
        result.content = args[++i];
        break;
      case '--action':
        result.action = args[++i];
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
  npx tsx marketing-agent/scripts/test-signal.ts           Insert a random test signal
  npx tsx marketing-agent/scripts/test-signal.ts --category 3          Use specific category (1-8)
  npx tsx marketing-agent/scripts/test-signal.ts --content "Text"      Custom content
  npx tsx marketing-agent/scripts/test-signal.ts --action reply_supportive  Set suggested_action (default: reply_supportive)
  npx tsx marketing-agent/scripts/test-signal.ts --reset 123           Re-trigger signal #123
  npx tsx marketing-agent/scripts/test-signal.ts --reset-all           Re-trigger all signals

Options:
  --category <1-8>   Signal category (default: random 1-8)
  --content <text>   Custom tweet content (default: random test tweet)
  --action <value>   Suggested action: reply_supportive, act, analyze, monitor (default: reply_supportive)
  --reset <id>       Reset notified_at to NULL for specific signal ID
  --reset-all        Reset notified_at to NULL for ALL signals
  --help, -h         Show this help message
`);
        process.exit(0);
        break;
    }
  }

  return result;
}

function getAlertLevel(category: number): string {
  if (category <= 2) return 'red';
  if (category <= 5) return 'orange';
  return 'yellow';
}

function getRandomTestTweet(): { content: string; category: number } {
  return TEST_TWEETS[Math.floor(Math.random() * TEST_TWEETS.length)];
}

function main(): void {
  const args = parseArgs();

  // DB path relative to project root
  const dbPath = join(process.cwd(), 'data', 'signals.db');
  const db = new Database(dbPath);

  try {
    // Handle reset modes first
    if (args.reset !== undefined) {
      const stmt = db.prepare('UPDATE signals SET notified_at = NULL WHERE id = ?');
      const result = stmt.run(args.reset);
      if (result.changes > 0) {
        console.log(`✅ Signal #${args.reset} reset. Bot will post it within 30s.`);
      } else {
        console.error(`❌ Signal #${args.reset} not found.`);
        process.exit(1);
      }
      return;
    }

    if (args.resetAll) {
      const stmt = db.prepare('UPDATE signals SET notified_at = NULL');
      const result = stmt.run();
      console.log(`✅ ${result.changes} signals reset. Bot will post them within 30s.`);
      return;
    }

    // Determine tweet content and category
    let content: string;
    let category: number;

    if (args.content) {
      content = args.content;
      category = args.category ?? Math.floor(Math.random() * 8) + 1;
    } else {
      const tweet = getRandomTestTweet();
      content = tweet.content;
      category = args.category ?? tweet.category;
    }

    // Generate a unique tweet_id (timestamp-based to avoid collisions)
    const tweetId = `test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const author = 'test_user';
    const url = `https://x.com/test_user/status/${tweetId}`;
    const confidence = Math.floor(Math.random() * 30) + 60; // 60-90
    const alertLevel = getAlertLevel(category);
    const sourceAdapter = 'test_injector';
    const createdAt = Math.floor(Date.now() / 1000);

    // Prepare raw JSON
    const rawJson = JSON.stringify({
      id: tweetId,
      author: `@${author}`,
      content,
      url,
      created_at: createdAt,
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

    // Insert the signal
    const insertStmt = db.prepare(`
      INSERT INTO signals (
        tweet_id, author, content, url, category, confidence,
        sentiment, priority, risk_level, suggested_action, alert_level,
        source_adapter, raw_json, created_at, notified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      tweetId,
      `@${author}`,
      content,
      url,
      category,
      confidence,
      'positive',
      Math.floor(Math.random() * 3) + 1,
      category <= 2 ? 'high' : category <= 5 ? 'medium' : 'low',
      args.action ?? 'reply_supportive',
      alertLevel,
      sourceAdapter,
      rawJson,
      createdAt,
      null // notified_at = NULL so bot picks it up
    );

    const signalId = result.lastInsertRowid;

    console.log(`
✅ Test signal #${signalId} inserted!
   Category: ${category} (${alertLevel})
   Author: @${author}
   Content: "${content.substring(0, 60)}..."
   Alert Level: ${alertLevel}
   Suggested Action: ${args.action ?? 'reply_supportive'}

🤖 Bot will post it to Discord within 30s.
`);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
