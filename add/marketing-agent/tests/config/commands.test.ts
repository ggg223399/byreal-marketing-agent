import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
  readGovernanceConfig,
  handleSourcesList,
  handleSourceSetMaxTweets,
  handleConfigView,
  handleEditableYamlRollback,
  handleEditableConfigFileRollback,
  handleEditableConfigFileSet,
  handleEditableConfigFileView,
  getEditableYamlSectionChoices,
  getEditableYamlSectionContent,
  handleEditableYamlSectionSet,
  handleEditableYamlSet,
  handleEditableYamlView,
  handlePromptSet,
  handlePromptView,
} from '../../config/commands.js';

const ACCOUNTS_YAML = `accounts:
  core:
    - handle: solana
    - handle: toly
  top-dapps:
    - handle: JupiterExchange
    - handle: Raydium
`;

const SOURCES_YAML = `sources:
  - name: trend-keywords
    schedule: "10 * * * *"
    lookback_minutes: 60
    max_tweets: 3
    keywords:
      - AI agent Solana
      - DeFi AI agent
    prompt: "Search for tweets discussing: {{keywords}}"
  - name: direct-mentions
    schedule: "7,37 * * * *"
    max_tweets: 5
    prompt: "Search for Byreal mentions"
`;

const GOVERNANCE_YAML = `config_permissions:
  admin_user_ids: []
  admin_role_ids: []
  allowed_user_ids: []
  allowed_role_ids: []
  allowed_channel_ids: []
`;

const JUDGE_YAML = `rules: |
  Judge prompt here
output_schema:
  alertLevel:
    type: enum
    values: [red, orange, yellow, none]
    description: Alert level
  reasoning:
    type: string
    max_length: 200
    description: Reasoning
`;

const REACTOR_YAML = `brand_context_ref: ../prompts/brand_context.md
rules: |
  Reactor prompt here
output_schema:
  suggestedAction:
    type: enum
    values: [reply_supportive, qrt_positioning, collab_opportunity, like_only, explore_signal, escalate_internal, none]
    description: Suggested action
  replyAngle:
    type: string
    max_length: 300
    description: Reply angle
  tones:
    type: array
    item_fields: [id, label, description]
    min_items: 1
    max_items: 3
    description: Tone options
`;

const ROUTING_YAML = `routing:
  default:
    channel: noise
  routes:
    - when:
        alert_level: red
      channel: crisis
`;

const BRAND_CONTEXT = `Byreal brand context goes here.
`;

let tmpDir: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'byreal-cmd-test-'));
  tmpDir = path.join(tmpRoot, 'config');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'accounts.yaml'), ACCOUNTS_YAML);
  writeFileSync(path.join(tmpDir, 'sources.yaml'), SOURCES_YAML);
  writeFileSync(path.join(tmpDir, 'governance.yaml'), GOVERNANCE_YAML);
  writeFileSync(path.join(tmpDir, 'judge.yaml'), JUDGE_YAML);
  writeFileSync(path.join(tmpDir, 'reactor.yaml'), REACTOR_YAML);
  writeFileSync(path.join(tmpDir, 'routing.yaml'), ROUTING_YAML);
  const promptsDir = path.join(tmpRoot, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(path.join(promptsDir, 'brand_context.md'), BRAND_CONTEXT);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('accounts commands', () => {
  it('lists accounts by group', () => {
    const result = handleAccountsList(tmpDir, 'core');
    expect(result.success).toBe(true);
    expect(result.message).toContain('solana');
    expect(result.message).toContain('toly');
  });

  it('lists all groups when no group specified', () => {
    const result = handleAccountsList(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('core');
    expect(result.message).toContain('top-dapps');
  });

  it('returns error for unknown group', () => {
    const result = handleAccountsList(tmpDir, 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('adds an account to a group', () => {
    const result = handleAccountsAdd(tmpDir, 'core', 'calilyliu', 'user1');
    expect(result.success).toBe(true);
    const updated = readFileSync(path.join(tmpDir, 'accounts.yaml'), 'utf-8');
    expect(updated).toContain('calilyliu');
  });

  it('strips @ prefix when adding', () => {
    const result = handleAccountsAdd(tmpDir, 'core', '@calilyliu', 'user1');
    expect(result.success).toBe(true);
    expect(result.message).toContain('@calilyliu');
    const updated = readFileSync(path.join(tmpDir, 'accounts.yaml'), 'utf-8');
    expect(updated).toContain('calilyliu');
    expect(updated).not.toContain('@@');
  });

  it('rejects duplicate account (case-insensitive)', () => {
    const result = handleAccountsAdd(tmpDir, 'core', 'Solana', 'user1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already');
  });

  it('rejects add to unknown group', () => {
    const result = handleAccountsAdd(tmpDir, 'nonexistent', 'foo', 'user1');
    expect(result.success).toBe(false);
  });

  it('removes an account from a group', () => {
    const result = handleAccountsRemove(tmpDir, 'core', 'toly', 'user1');
    expect(result.success).toBe(true);
    const updated = readFileSync(path.join(tmpDir, 'accounts.yaml'), 'utf-8');
    expect(updated).not.toContain('toly');
  });

  it('fails to remove non-existent account', () => {
    const result = handleAccountsRemove(tmpDir, 'core', 'nobody', 'user1');
    expect(result.success).toBe(false);
  });

  it('creates .bak backup on write', () => {
    handleAccountsAdd(tmpDir, 'core', 'newaccount', 'user1');
    const backup = readFileSync(path.join(tmpDir, 'accounts.yaml.bak'), 'utf-8');
    expect(backup).toContain('solana');
    expect(backup).not.toContain('newaccount');
  });
});

describe('keywords commands', () => {
  it('lists keywords from trend-keywords source', () => {
    const result = handleKeywordsList(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('AI agent Solana');
    expect(result.message).toContain('DeFi AI agent');
  });

  it('adds a keyword', () => {
    const result = handleKeywordsAdd(tmpDir, 'Solana perps', 'user1');
    expect(result.success).toBe(true);
    const updated = readFileSync(path.join(tmpDir, 'sources.yaml'), 'utf-8');
    expect(updated).toContain('Solana perps');
  });

  it('rejects duplicate keyword', () => {
    const result = handleKeywordsAdd(tmpDir, 'AI agent Solana', 'user1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already');
  });

  it('removes a keyword', () => {
    const result = handleKeywordsRemove(tmpDir, 'DeFi AI agent', 'user1');
    expect(result.success).toBe(true);
    const updated = readFileSync(path.join(tmpDir, 'sources.yaml'), 'utf-8');
    expect(updated).not.toContain('DeFi AI agent');
  });

  it('fails to remove non-existent keyword', () => {
    const result = handleKeywordsRemove(tmpDir, 'nonexistent', 'user1');
    expect(result.success).toBe(false);
  });
});

describe('sources commands', () => {
  it('lists all sources with schedule and max_tweets', () => {
    const result = handleSourcesList(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('trend-keywords');
    expect(result.message).toContain('direct-mentions');
    expect(result.message).toContain('2 keywords');
  });

  it('sets max_tweets for a source', () => {
    const result = handleSourceSetMaxTweets(tmpDir, 'direct-mentions', 10, 'user1');
    expect(result.success).toBe(true);
    expect(result.message).toContain('5');  // old value
    expect(result.message).toContain('10'); // new value
  });

  it('rejects invalid max_tweets', () => {
    expect(handleSourceSetMaxTweets(tmpDir, 'direct-mentions', 0, 'u').success).toBe(false);
    expect(handleSourceSetMaxTweets(tmpDir, 'direct-mentions', 25, 'u').success).toBe(false);
  });

  it('rejects unknown source', () => {
    const result = handleSourceSetMaxTweets(tmpDir, 'nonexistent', 5, 'user1');
    expect(result.success).toBe(false);
  });
});

describe('config view', () => {
  it('shows overview with accounts and sources', () => {
    const result = handleConfigView(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Accounts');
    expect(result.message).toContain('Sources');
    expect(result.message).toContain('core');
    expect(result.message).toContain('trend-keywords');
  });
});

describe('prompt commands', () => {
  it('views a source prompt', () => {
    const result = handlePromptView(tmpDir, 'source', 'direct-mentions');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Byreal mentions');
  });

  it('updates a source prompt', () => {
    const result = handlePromptSet(tmpDir, 'source', 'New source prompt', 'user1', 'direct-mentions');
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'sources.yaml'), 'utf-8')).toContain('New source prompt');
  });

  it('views and updates judge rules', () => {
    expect(handlePromptView(tmpDir, 'judge').message).toContain('Judge prompt here');
    expect(handlePromptSet(tmpDir, 'judge', 'Updated judge rules', 'user1').success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'judge.yaml'), 'utf-8')).toContain('Updated judge rules');
  });

  it('views and updates reactor rules', () => {
    expect(handlePromptView(tmpDir, 'reactor').message).toContain('Reactor prompt here');
    expect(handlePromptSet(tmpDir, 'reactor', 'Updated reactor rules', 'user1').success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'reactor.yaml'), 'utf-8')).toContain('Updated reactor rules');
  });

  it('views and updates brand context', () => {
    expect(handlePromptView(tmpDir, 'brand-context').message).toContain('Byreal brand context');
    expect(handlePromptSet(tmpDir, 'brand-context', 'Updated brand context', 'user1').success).toBe(true);
    expect(readFileSync(path.join(tmpRoot, 'prompts', 'brand_context.md'), 'utf-8')).toContain('Updated brand context');
  });

  it('rejects source updates without a source name', () => {
    expect(handlePromptSet(tmpDir, 'source', 'x', 'user1').success).toBe(false);
  });
});

describe('yaml commands', () => {
  it('views a full yaml file', () => {
    const result = handleEditableYamlView(tmpDir, 'sources');
    expect(result.success).toBe(true);
    expect(result.message).toContain('sources.yaml');
    expect(result.message).toContain('direct-mentions');
  });

  it('views accounts.yaml as a file-level config target', () => {
    const result = handleEditableConfigFileView(tmpDir, 'accounts');
    expect(result.success).toBe(true);
    expect(result.message).toContain('accounts.yaml');
    expect(result.message).toContain('JupiterExchange');
  });

  it('updates a full yaml file after validation', () => {
    const next = `sources:
  - name: trend-keywords
    schedule: "10 * * * *"
    lookback_minutes: 60
    max_tweets: 3
    keywords:
      - AI agent Solana
    prompt: "Search for tweets discussing: {{keywords}}"
  - name: direct-mentions
    schedule: "7,37 * * * *"
    max_tweets: 8
    prompt: "Search for stronger Byreal mentions"
`;
    const result = handleEditableYamlSet(tmpDir, 'sources', next, 'user1');
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'sources.yaml'), 'utf-8')).toContain('stronger Byreal mentions');
    expect(readFileSync(path.join(tmpDir, 'sources.yaml.bak'), 'utf-8')).toContain('Search for Byreal mentions');
  });

  it('updates accounts.yaml through the generic file-level flow', () => {
    const next = `accounts:
  core:
    - handle: solana
    - handle: toly
    - handle: vibhu
  top-dapps:
    - handle: JupiterExchange
    - handle: Raydium
`;
    const result = handleEditableConfigFileSet(tmpDir, 'accounts', next, 'user1');
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'accounts.yaml'), 'utf-8')).toContain('vibhu');
    expect(readFileSync(path.join(tmpDir, 'accounts.yaml.bak'), 'utf-8')).toContain('toly');
  });

  it('rejects invalid yaml and preserves original file', () => {
    const result = handleEditableYamlSet(tmpDir, 'judge', 'rules: |\n  broken\noutput_schema: [', 'user1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Validation failed');
    expect(readFileSync(path.join(tmpDir, 'judge.yaml'), 'utf-8')).toBe(JUDGE_YAML);
  });

  it('rejects schema-invalid yaml and preserves original file', () => {
    const result = handleEditableYamlSet(
      tmpDir,
      'routing',
      'routing:\n  default:\n    channel: noise\n  routes: []\n',
      'user1',
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('must have at least one route');
    expect(readFileSync(path.join(tmpDir, 'routing.yaml'), 'utf-8')).toBe(ROUTING_YAML);
  });

  it('rolls back to the previous backup', () => {
    handleEditableYamlSet(
      tmpDir,
      'reactor',
      `brand_context_ref: ../prompts/brand_context.md
rules: |
  Updated reactor prompt
output_schema:
  suggestedAction:
    type: enum
    values: [reply_supportive, qrt_positioning, collab_opportunity, like_only, explore_signal, escalate_internal, none]
    description: Suggested action
  replyAngle:
    type: string
    max_length: 300
    description: Reply angle
  tones:
    type: array
    item_fields: [id, label, description]
    min_items: 1
    max_items: 3
    description: Tone options
`,
      'user1',
    );

    const result = handleEditableYamlRollback(tmpDir, 'reactor');
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'reactor.yaml'), 'utf-8')).toBe(REACTOR_YAML);
  });

  it('rolls back accounts.yaml using the generic file-level flow', () => {
    handleEditableConfigFileSet(
      tmpDir,
      'accounts',
      `accounts:
  core:
    - handle: solana
  top-dapps:
    - handle: JupiterExchange
`,
      'user1',
    );

    const result = handleEditableConfigFileRollback(tmpDir, 'accounts');
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'accounts.yaml'), 'utf-8')).toBe(ACCOUNTS_YAML);
  });

  it('views brand_context.md as an editable config file', () => {
    const result = handleEditableConfigFileView(tmpDir, 'brand-context');
    expect(result.success).toBe(true);
    expect(result.message).toContain('brand_context.md');
    expect(result.message).toContain('Byreal brand context goes here');
  });

  it('updates brand_context.md and writes a backup', () => {
    const result = handleEditableConfigFileSet(
      tmpDir,
      'brand-context',
      'Updated brand context file',
      'user1',
    );
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpRoot, 'prompts', 'brand_context.md'), 'utf-8')).toContain('Updated brand context file');
    expect(readFileSync(path.join(tmpRoot, 'prompts', 'brand_context.md.bak'), 'utf-8')).toContain('Byreal brand context goes here');
  });

  it('rolls back brand_context.md using the latest backup', () => {
    handleEditableConfigFileSet(
      tmpDir,
      'brand-context',
      'Updated brand context file',
      'user1',
    );

    const result = handleEditableConfigFileRollback(tmpDir, 'brand-context');
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(tmpRoot, 'prompts', 'brand_context.md'), 'utf-8')).toBe(BRAND_CONTEXT);
  });

  it('lists source section choices for long sources.yaml editing', () => {
    const result = getEditableYamlSectionChoices(tmpDir, 'sources');
    expect(result.map((item) => item.value)).toEqual(['trend-keywords', 'direct-mentions']);
  });

  it('returns a single source entry as yaml', () => {
    const result = getEditableYamlSectionContent(tmpDir, 'sources', 'direct-mentions');
    expect(result).toContain('name: direct-mentions');
    expect(result).toContain('prompt: Search for Byreal mentions');
  });

  it('updates one source entry and validates the whole sources file', () => {
    const result = handleEditableYamlSectionSet(
      tmpDir,
      'sources',
      'direct-mentions',
      `name: direct-mentions
schedule: "7,37 * * * *"
max_tweets: 9
prompt: Search for stronger Byreal mentions
`,
      'user1',
    );
    expect(result.success).toBe(true);
    const updated = readFileSync(path.join(tmpDir, 'sources.yaml'), 'utf-8');
    expect(updated).toContain('max_tweets: 9');
    expect(updated).toContain('stronger Byreal mentions');
    expect(updated).toContain('trend-keywords');
  });

  it('rejects invalid source entry updates and preserves the original sources file', () => {
    const result = handleEditableYamlSectionSet(
      tmpDir,
      'sources',
      'direct-mentions',
      `name: direct-mentions
max_tweets: 9
prompt: Missing schedule should fail
`,
      'user1',
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('missing "schedule"');
    expect(readFileSync(path.join(tmpDir, 'sources.yaml'), 'utf-8')).toBe(SOURCES_YAML);
  });
});

describe('governance commands', () => {
  it('lists governance config', () => {
    const result = handleGovernanceList(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('allowed_user_ids');
  });

  it('adds and removes allowed users', () => {
    expect(handleGovernanceAddUser(tmpDir, '123', 'allowed_user_ids').success).toBe(true);
    expect(readGovernanceConfig(tmpDir).allowed_user_ids).toContain('123');
    expect(handleGovernanceRemoveUser(tmpDir, '123', 'allowed_user_ids').success).toBe(true);
    expect(readGovernanceConfig(tmpDir).allowed_user_ids).not.toContain('123');
  });

  it('adds and removes allowed roles', () => {
    expect(handleGovernanceAddRole(tmpDir, '999', 'allowed_role_ids').success).toBe(true);
    expect(readGovernanceConfig(tmpDir).allowed_role_ids).toContain('999');
    expect(handleGovernanceRemoveRole(tmpDir, '999', 'allowed_role_ids').success).toBe(true);
    expect(readGovernanceConfig(tmpDir).allowed_role_ids).not.toContain('999');
  });

  it('sets and clears config channel restriction', () => {
    expect(handleGovernanceSetChannel(tmpDir, '777').success).toBe(true);
    expect(readGovernanceConfig(tmpDir).allowed_channel_ids).toEqual(['777']);
    expect(handleGovernanceClearChannel(tmpDir).success).toBe(true);
    expect(readGovernanceConfig(tmpDir).allowed_channel_ids).toEqual([]);
  });
});
