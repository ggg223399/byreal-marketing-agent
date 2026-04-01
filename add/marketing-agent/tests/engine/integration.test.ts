import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { loadAllConfigs } from '../../engine/config-loader.js';
import { processSource } from '../../engine/pipeline.js';
import type { RawTweet, ProcessedSignal, JudgeConfig, ReactorConfig } from '../../engine/types.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

describe('integration', () => {
  function findSource(configs: ReturnType<typeof loadAllConfigs>, name: string) {
    const source = configs.sources.sources.find((item) => item.name === name);
    expect(source).toBeDefined();
    return source!;
  }

  it('loads test fixture configs and runs full pipeline', async () => {
    const configs = loadAllConfigs(FIXTURES);

    const tweets: RawTweet[] = [
      { id: '1', author: '@jupiter_exchange', content: 'Excited to integrate with @byreal_io CLMM vaults!', url: 'https://x.com/1', created_at: Date.now() },
      { id: '2', author: '@spammer', content: 'BUY NOW', url: 'https://x.com/2', created_at: Date.now() },
      { id: '3', author: '@analyst', content: 'Interesting RWA developments on Solana with Byreal leading tokenized gold', url: 'https://x.com/3', created_at: Date.now() },
    ];

    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn().mockResolvedValue(new Map([
      ['1', { alertLevel: 'orange', reasoning: 'Jupiter integration announcement' }],
      ['2', { alertLevel: 'none', reasoning: 'Spam' }],
      ['3', { alertLevel: 'yellow', reasoning: 'RWA discussion mentions Byreal' }],
    ]));
    const mockReactor = vi.fn()
      .mockResolvedValueOnce({ suggestedAction: 'reply_supportive', tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }], replyAngle: 'Thank Jupiter, mention deeper liquidity' })
      .mockResolvedValueOnce({ suggestedAction: 'collab_opportunity', tones: [{ id: 'technical', label: 'Technical', description: 'Data-driven' }], replyAngle: 'Flag this for BD follow-up around agent infrastructure on Solana.' });

    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    const source = findSource(configs, 'mentions');

    await processSource({
      source,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: mockReactor,
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: configs.judge,
      reactorConfig: configs.reactor,
      routingConfig: configs.routing,
      brandContext: 'Byreal is a hybrid DEX on Solana.',
      templateVars: {},
    });

    // Tweet 2 (spam) was judged none — filtered out
    expect(mockReactor).toHaveBeenCalledTimes(2);

    // Two signals routed
    expect(routedSignals).toHaveLength(2);

    // Tweet 1 → reply_supportive → needs-reply
    expect(routedSignals[0].signal.alertLevel).toBe('orange');
    expect(routedSignals[0].signal.suggestedAction).toBe('reply_supportive');
    expect(routedSignals[0].channels).toEqual(['needs-reply']);

    // Tweet 3 → collab_opportunity → collab-opportunities
    expect(routedSignals[1].signal.alertLevel).toBe('yellow');
    expect(routedSignals[1].signal.suggestedAction).toBe('collab_opportunity');
    expect(routedSignals[1].channels).toEqual(['collab-opportunities']);
  });

  it('skip_judge source bypasses Judge and Reactor', async () => {
    const configs = loadAllConfigs(FIXTURES);
    const skipSource = findSource(configs, 'ecosystem-core');

    const tweets: RawTweet[] = [
      { id: '10', author: '@jupiter_exchange', content: 'New feature!', url: 'https://x.com/10', created_at: Date.now() },
    ];

    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn();
    const mockReactor = vi.fn();
    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    await processSource({
      source: skipSource,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: mockReactor,
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: configs.judge,
      reactorConfig: configs.reactor,
      routingConfig: configs.routing,
      brandContext: 'test',
      templateVars: {},
    });

    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockReactor).not.toHaveBeenCalled();
    expect(routedSignals).toHaveLength(1);
    expect(routedSignals[0].signal.alertLevel).toBe('orange');
    expect(routedSignals[0].signal.suggestedAction).toBe('reply_supportive');
  });

  it('routes explore-window discoveries to trending when reactor returns explore_signal', async () => {
    const configs = loadAllConfigs(FIXTURES);
    const source = findSource(configs, 'explore-window');
    const tweets: RawTweet[] = [
      { id: '50', author: '@builder', content: 'A new Solana agent wallet primitive is getting real traction and reshaping distribution.', url: 'https://x.com/50', created_at: Date.now() },
    ];
    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    await processSource({
      source,
      searchFn: vi.fn().mockResolvedValue(tweets),
      judgeFn: vi.fn().mockResolvedValue(new Map([
        ['50', { alertLevel: 'orange', reasoning: 'Strong new narrative with traction' }],
      ])),
      reactFn: vi.fn().mockResolvedValue({
        suggestedAction: 'explore_signal',
        tones: [{ id: 'technical', label: 'Technical', description: 'Research-oriented framing' }],
        replyAngle: 'Flag this as an explore item for the team rather than public engagement.',
      }),
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: configs.judge,
      reactorConfig: configs.reactor,
      routingConfig: configs.routing,
      brandContext: 'Byreal is a hybrid DEX on Solana.',
      templateVars: {},
    });

    expect(routedSignals).toHaveLength(1);
    expect(routedSignals[0].signal.suggestedAction).toBe('explore_signal');
    expect(routedSignals[0].channels).toEqual(['trending']);
  });

  it('pre_filter removes spam before Judge', async () => {
    const configs = loadAllConfigs(FIXTURES);
    const ecosystemSource = findSource(configs, 'ecosystem');

    const tweets: RawTweet[] = [
      { id: '20', author: '@partner', content: 'Byreal integration is live and working great!', url: '', created_at: Date.now() },
      { id: '21', author: '@bot', content: 'GIVEAWAY tag 3 friends to win!', url: '', created_at: Date.now() },
      { id: '22', author: '@x', content: 'hi', url: '', created_at: Date.now() }, // too short (min_length: 20)
    ];

    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn().mockResolvedValue(new Map([
      ['20', { alertLevel: 'orange', reasoning: 'Partner integration' }],
    ]));
    const mockReactor = vi.fn().mockResolvedValue({
      suggestedAction: 'reply_supportive', tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }], replyAngle: 'Celebrate the integration',
    });
    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    await processSource({
      source: ecosystemSource,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: mockReactor,
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: configs.judge,
      reactorConfig: configs.reactor,
      routingConfig: configs.routing,
      brandContext: 'test',
      templateVars: {},
    });

    // Only tweet 20 should survive pre_filter (21 matches giveaway, 22 too short)
    expect(mockJudge).toHaveBeenCalledWith(configs.judge, [tweets[0]], 'ecosystem');
    expect(routedSignals).toHaveLength(1);
  });
});
