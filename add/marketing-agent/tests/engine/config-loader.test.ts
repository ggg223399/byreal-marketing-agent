import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAllConfigs, loadSourcesConfig, loadJudgeConfig, loadReactorConfig, loadRoutingConfig, loadEnrichmentConfig, loadGeneratorConfig, resolveTemplateVars, loadAccountsList, loadBrandContext, resolveConfigRefPath } from '../../engine/config-loader.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'marketing-agent-config-'));
}

describe('config-loader', () => {
  describe('loadSourcesConfig', () => {
    it('loads and parses sources.yaml', () => {
      const config = loadSourcesConfig(path.join(FIXTURES, 'sources.yaml'));
      expect(config.sources).toHaveLength(5);
      expect(config.sources[0].name).toBe('mentions');
      expect(config.sources[1].keywords).toEqual(['AI agent Solana', 'Crypto AI agent']);
      expect(config.sources[2].name).toBe('explore-window');
      expect(config.sources[2].lookback_minutes).toBe(1440);
      expect(config.sources[3].skip_judge).toBe(true);
      expect(config.sources[3].groups).toEqual(['core']);
      expect(config.sources[3].default_labels?.alertLevel).toBe('orange');
      expect(config.sources[4].pre_filter?.exclude_patterns).toHaveLength(1);
    });

    it('throws on missing file', () => {
      expect(() => loadSourcesConfig('/nonexistent/sources.yaml')).toThrow('Config file not found');
    });
  });

  describe('loadJudgeConfig', () => {
    it('loads judge.yaml with rules and schema', () => {
      const config = loadJudgeConfig(path.join(FIXTURES, 'judge.yaml'));
      expect(config.rules).toContain('red');
      expect(config.output_schema.alertLevel.values).toEqual(['red', 'orange', 'yellow', 'none']);
    });

    it('throws on unsupported alertLevel enum values', () => {
      const dir = makeTmpDir();
      const file = path.join(dir, 'judge.yaml');
      writeFileSync(file, `rules: test\noutput_schema:\n  alertLevel:\n    type: enum\n    values: [red, purple]\n    description: Alert level\n  reasoning:\n    type: string\n    max_length: 200\n    description: Reasoning\n`);
      expect(() => loadJudgeConfig(file)).toThrow('judge.yaml: output_schema.alertLevel: unsupported enum values: purple');
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('loadReactorConfig', () => {
    it('loads reactor.yaml with brand_context_ref', () => {
      const config = loadReactorConfig(path.join(FIXTURES, 'reactor.yaml'));
      expect(config.brand_context_ref).toBe('tests/fixtures/brand_context.md');
      expect(config.output_schema.suggestedAction.values).toContain('reply_supportive');
      expect(config.output_schema.suggestedAction.values).toContain('collab_opportunity');
      expect(config.output_schema.suggestedAction.values).toContain('explore_signal');
      expect((config.output_schema.tones as unknown as Record<string, unknown>).type).toBe('array');
    });

    it('throws on unsupported suggestedAction enum values', () => {
      const dir = makeTmpDir();
      const file = path.join(dir, 'reactor.yaml');
      writeFileSync(file, `brand_context_ref: brand.md\nrules: test\noutput_schema:\n  suggestedAction:\n    type: enum\n    values: [reply_supportive, freestyle]\n    description: Action\n  tones:\n    type: array\n    min_items: 1\n    max_items: 3\n    item_fields: [id, label, description]\n    description: Tone options\n  replyAngle:\n    type: string\n    max_length: 300\n    description: Reply angle\n`);
      expect(() => loadReactorConfig(file)).toThrow('reactor.yaml: output_schema.suggestedAction: unsupported enum values: freestyle');
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('loadRoutingConfig', () => {
    it('loads routing.yaml with routes', () => {
      const config = loadRoutingConfig(path.join(FIXTURES, 'routing.yaml'));
      expect(config.routing.default.channel).toBe('noise');
      expect(config.routing.routes).toHaveLength(6);
      expect(config.routing.routes[0].channel).toBe('needs-reply');
    });
  });

  describe('loadEnrichmentConfig', () => {
    it('loads enrichment.yaml without requiring a dedicated trending channel', () => {
      const config = loadEnrichmentConfig(path.join(FIXTURES, 'enrichment.yaml'));
      expect(config.enrichment.delay_minutes).toBe(120);
      expect(config.enrichment.trending.enabled).toBe(true);
      expect(config.enrichment.trending.thresholds.views).toBe(5000);
    });
  });

  describe('resolveTemplateVars', () => {
    it('replaces {{active_keywords}} with joined keywords', () => {
      const result = resolveTemplateVars(
        'Search for {{active_keywords}} tweets',
        { active_keywords: 'RWA, tokenized, CLMM' }
      );
      expect(result).toBe('Search for RWA, tokenized, CLMM tweets');
    });

    it('preserves unmatched vars', () => {
      expect(resolveTemplateVars('{{missing}}', {})).toBe('{{missing}}');
    });

    it('replaces {{keywords}} with joined keywords', () => {
      const result = resolveTemplateVars(
        'Search for {{keywords}} tweets',
        { keywords: 'AI agent Solana, Crypto AI agent' }
      );
      expect(result).toBe('Search for AI agent Solana, Crypto AI agent tweets');
    });
  });

  describe('loadAccountsList', () => {
    it('loads all handles from unified accounts YAML', () => {
      const handles = loadAccountsList(path.join(FIXTURES, 'accounts.yaml'));
      expect(handles).toEqual(['jupiter_exchange', 'orca_so', 'titan_exchange']);
    });

    it('loads only requested groups from accounts YAML', () => {
      const handles = loadAccountsList(path.join(FIXTURES, 'accounts.yaml'), { groups: ['core'] });
      expect(handles).toEqual(['jupiter_exchange', 'orca_so']);
    });

    it('normalizes @prefix and tolerates legacy handle typos', () => {
      const dir = makeTmpDir();
      const file = path.join(dir, 'accounts.yaml');
      writeFileSync(
        file,
        [
          'accounts:',
          '  top_traders:',
          '    - hanlde: "@alpha_trader"',
          '    - handle: "@beta_trader"',
          '    - handle: "gamma_trader"',
        ].join('\n'),
      );

      const handles = loadAccountsList(file, { groups: ['top_traders'] });
      expect(handles).toEqual(['alpha_trader', 'beta_trader', 'gamma_trader']);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('resolveConfigRefPath', () => {
    it('resolves legacy config-prefixed refs relative to configDir', () => {
      const resolved = resolveConfigRefPath('/tmp/marketing-agent/config', 'config/accounts.yaml');
      expect(resolved).toBe('/tmp/marketing-agent/config/accounts.yaml');
    });

    it('resolves normal relative refs unchanged', () => {
      const resolved = resolveConfigRefPath('/tmp/marketing-agent/config', 'accounts.yaml');
      expect(resolved).toBe('/tmp/marketing-agent/config/accounts.yaml');
    });
  });

  describe('loadBrandContext', () => {
    it('loads brand context markdown', () => {
      const text = loadBrandContext(path.join(FIXTURES, 'brand_context.md'));
      expect(text).toContain('hybrid DEX');
    });

    it('throws on missing file', () => {
      expect(() => loadBrandContext('/nonexistent/brand.md')).toThrow('Brand context file not found');
    });
  });

  describe('loadGeneratorConfig', () => {
    it('loads generator.yaml with model and temperature', () => {
      const config = loadGeneratorConfig(path.join(FIXTURES, 'generator.yaml'));
      expect(config.model).toBe('claude-sonnet-4-5-20250514');
      expect(config.temperature).toBe(0.7);
      expect(config.max_tokens).toBe(400);
      expect(config.brand_context_ref).toBe('tests/fixtures/brand_context.md');
    });

    it('throws on missing model', () => {
      const dir = makeTmpDir();
      const file = path.join(dir, 'generator.yaml');
      writeFileSync(file, 'temperature: 0.7\nmax_tokens: 400\nbrand_context_ref: brand.md\n');
      expect(() => loadGeneratorConfig(file)).toThrow('generator.yaml: missing "model"');
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('loadAllConfigs', () => {
    it('loads all 6 configs from a directory', () => {
      const configs = loadAllConfigs(FIXTURES);
      expect(configs.sources.sources.length).toBeGreaterThan(0);
      expect(configs.judge.rules).toBeTruthy();
      expect(configs.reactor.rules).toBeTruthy();
      expect(configs.routing.routing.routes.length).toBeGreaterThan(0);
      expect(configs.enrichment.enrichment.batch_size).toBe(20);
      expect(configs.generator.model).toBeTruthy();
    });
  });
});
