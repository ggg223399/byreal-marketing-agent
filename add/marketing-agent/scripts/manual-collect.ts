#!/usr/bin/env tsx
import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAllConfigs } from '../engine/config-loader.js';
import { createEngine } from '../engine/index.js';

const DEFAULT_CONFIG_DIR = 'marketing-agent/config';

export interface ManualCollectOptions {
  sourceNames: string[];
  configDir?: string;
  model?: string;
  dryRun: boolean;
  listOnly: boolean;
}

export function parseManualCollectArgs(argv: string[]): ManualCollectOptions {
  const options: ManualCollectOptions = {
    sourceNames: [],
    dryRun: false,
    listOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--source') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --source');
      options.sourceNames.push(...value.split(',').map(item => item.trim()).filter(Boolean));
      continue;
    }

    if (arg === '--config-dir') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --config-dir');
      options.configDir = value;
      continue;
    }

    if (arg === '--model') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --model');
      options.model = value;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--list') {
      options.listOnly = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function resolveManualCollectSources(
  availableSources: string[],
  requestedSources: string[],
): string[] {
  if (requestedSources.length === 0) return availableSources;

  const missing = requestedSources.filter(name => !availableSources.includes(name));
  if (missing.length > 0) {
    throw new Error(`Unknown source(s): ${missing.join(', ')}. Available: ${availableSources.join(', ')}`);
  }

  return [...new Set(requestedSources)];
}

function printUsage(): void {
  console.log(`Usage:
  npm run marketing:collect -- --source crisis
  npm run marketing:collect -- --source trend-keywords,explore-window
  npm run marketing:collect -- --list

Options:
  --source <name[,name]>   Run one or more sources immediately
  --list                   List available source names and exit
  --dry-run                Build prompts and routing decisions without DB writes
  --config-dir <path>      Override config directory (default: marketing-agent/config)
  --model <id>             Override Claude model used by Judge/Reactor
  --help, -h               Show this help

If --source is omitted, the command runs all sources once in config order.`);
}

async function main(): Promise<void> {
  const options = parseManualCollectArgs(process.argv.slice(2));
  const configDir = path.resolve(process.cwd(), options.configDir ?? DEFAULT_CONFIG_DIR);
  const configs = loadAllConfigs(configDir);
  const availableSources = configs.sources.sources.map(source => source.name);

  if (options.listOnly) {
    console.log(availableSources.join('\n'));
    return;
  }

  const selectedSources = resolveManualCollectSources(availableSources, options.sourceNames);
  const engine = createEngine({
    configDir,
    model: options.model,
    dryRun: options.dryRun,
  });

  let failed = false;
  for (const sourceName of selectedSources) {
    console.log(`[manual-collect] Running source "${sourceName}"...`);
    try {
      await engine.runSource(sourceName);
    } catch (error) {
      failed = true;
      console.error(`[manual-collect] Source "${sourceName}" failed:`, error);
    }
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(`[manual-collect] Completed ${selectedSources.length} source(s).`);
}

const isDirectRun = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  void main().catch((error) => {
    console.error('[manual-collect] Fatal error:', error);
    process.exit(1);
  });
}
