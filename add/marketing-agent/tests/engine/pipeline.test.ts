import { describe, it, expect, vi } from 'vitest';
import { processSource } from '../../engine/pipeline.js';
import type { SourceConfig, JudgeConfig, ReactorConfig, RoutingConfig, RawTweet, ProcessedSignal } from '../../engine/types.js';

const JUDGE_CONFIG: JudgeConfig = {
  rules: 'Judge importance.',
  output_schema: {
    alertLevel: { type: 'enum', values: ['red', 'orange', 'yellow', 'none'], description: '' },
    reasoning: { type: 'string', max_length: 200, description: '' },
  },
};

const REACTOR_CONFIG: ReactorConfig = {
  brand_context_ref: 'brand.md',
  rules: 'Decide how to react.',
  output_schema: {
    suggestedAction: { type: 'enum', values: ['reply_supportive', 'qrt_positioning', 'collab_opportunity', 'like_only', 'explore_signal', 'escalate_internal', 'none'], description: '' },
    replyAngle: { type: 'string', max_length: 300, description: '' },
    tones: { type: 'array', min_items: 1, max_items: 3, item_fields: ['id', 'label', 'description'], description: '' },
  },
};

const ROUTING_CONFIG: RoutingConfig = {
  routing: {
    default: { channel: 'noise' },
    routes: [
      { match: { suggestedAction: 'reply_supportive' }, channel: 'needs-reply' },
      { match: { suggestedAction: 'qrt_positioning' }, channel: 'needs-qrt' },
      { match: { suggestedAction: 'collab_opportunity' }, channel: 'collab-opportunities' },
      { match: { suggestedAction: 'escalate_internal' }, channel: 'escalation' },
      { match: { suggestedAction: 'like_only' }, channel: 'engagement' },
      { match: { suggestedAction: 'explore_signal' }, channel: 'trending' },
    ],
  },
};

function makeTweet(id: string, content: string): RawTweet {
  return { id, author: `@user${id}`, content, url: `https://x.com/${id}`, created_at: Date.now() };
}

describe('pipeline orchestrator', () => {
  it('skip_judge source goes directly to router with default labels', async () => {
    const source: SourceConfig = {
      name: 'core',
      schedule: '*/30 * * * *',
      prompt: 'Search core partners',
      skip_judge: true,
      default_labels: { alertLevel: 'orange', suggestedAction: 'reply_supportive' },
    };

    const tweets = [makeTweet('1', 'Integration live!')];
    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn();
    const mockReactor = vi.fn();
    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    const result = await processSource({
      source,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: mockReactor,
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: JUDGE_CONFIG,
      reactorConfig: REACTOR_CONFIG,
      routingConfig: ROUTING_CONFIG,
      brandContext: 'test',
      templateVars: {},
    });

    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockReactor).not.toHaveBeenCalled();
    expect(routedSignals).toHaveLength(1);
    expect(routedSignals[0].signal.alertLevel).toBe('orange');
    expect(routedSignals[0].signal.suggestedAction).toBe('reply_supportive');
    expect(routedSignals[0].channels).toContain('needs-reply');
    expect(result.routed).toBe(1);
    expect(result.judgedNone).toBe(0);
  });

  it('normal source: Judge -> filter none -> Reactor -> Route', async () => {
    const source: SourceConfig = {
      name: 'mentions',
      schedule: '*/15 * * * *',
      prompt: 'Search for Byreal',
    };

    const tweets = [
      makeTweet('1', 'Byreal is great'),
      makeTweet('2', 'random spam'),
    ];

    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn().mockResolvedValue(new Map([
      ['1', { alertLevel: 'orange', reasoning: 'Positive mention' }],
      ['2', { alertLevel: 'none', reasoning: 'Spam' }],
    ]));
    const mockReactor = vi.fn().mockResolvedValue({
      suggestedAction: 'reply_supportive', tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }], replyAngle: 'be friendly',
    });
    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    const result = await processSource({
      source,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: mockReactor,
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: JUDGE_CONFIG,
      reactorConfig: REACTOR_CONFIG,
      routingConfig: ROUTING_CONFIG,
      brandContext: 'test',
      templateVars: {},
    });

    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(mockReactor).toHaveBeenCalledTimes(1); // only for tweet 1
    expect(routedSignals).toHaveLength(1);
    expect(routedSignals[0].signal.tweet.id).toBe('1');
    expect(result.routed).toBe(1);
    expect(result.judgedNone).toBe(1);
  });

  it('pre_filter reduces tweets before Judge', async () => {
    const source: SourceConfig = {
      name: 'ecosystem',
      schedule: '*/30 * * * *',
      prompt: 'Search ecosystem',
      pre_filter: { exclude_patterns: ['(?i)giveaway'] },
    };

    const tweets = [
      makeTweet('1', 'Byreal CLMM is impressive'),
      makeTweet('2', 'Giveaway! Tag 3 friends'),
    ];

    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn().mockResolvedValue(new Map([
      ['1', { alertLevel: 'orange', reasoning: 'Important' }],
    ]));
    const mockReactor = vi.fn().mockResolvedValue({
      suggestedAction: 'reply_supportive', tones: [{ id: 'technical', label: 'Technical', description: 'Technical tone' }], replyAngle: 'discuss CLMM',
    });
    const routedSignals: { signal: ProcessedSignal; channels: string[] }[] = [];

    const result = await processSource({
      source,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: mockReactor,
      routeFn: (signal, channels) => routedSignals.push({ signal, channels }),
      judgeConfig: JUDGE_CONFIG,
      reactorConfig: REACTOR_CONFIG,
      routingConfig: ROUTING_CONFIG,
      brandContext: 'test',
      templateVars: {},
    });

    // Judge only received 1 tweet (giveaway filtered)
    expect(mockJudge).toHaveBeenCalledWith(JUDGE_CONFIG, [tweets[0]], 'ecosystem');
    expect(result.filteredByPreFilter).toBe(1);
    expect(result.routed).toBe(1);
  });

  it('returns early on empty search results', async () => {
    const source: SourceConfig = {
      name: 'empty',
      schedule: '0 * * * *',
      prompt: 'Search',
    };

    const mockSearch = vi.fn().mockResolvedValue([]);
    const mockJudge = vi.fn();
    const mockRoute = vi.fn();

    const result = await processSource({
      source,
      searchFn: mockSearch,
      judgeFn: mockJudge,
      reactFn: vi.fn(),
      routeFn: mockRoute,
      judgeConfig: JUDGE_CONFIG,
      reactorConfig: REACTOR_CONFIG,
      routingConfig: ROUTING_CONFIG,
      brandContext: 'test',
      templateVars: {},
    });

    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(result.totalSearched).toBe(0);
  });

  it('resolves template vars in prompt', async () => {
    const source: SourceConfig = {
      name: 'narratives',
      schedule: '0 * * * *',
      prompt: 'Search for {{active_keywords}}',
    };

    const mockSearch = vi.fn().mockResolvedValue([]);

    await processSource({
      source,
      searchFn: mockSearch,
      judgeFn: vi.fn(),
      reactFn: vi.fn(),
      routeFn: vi.fn(),
      judgeConfig: JUDGE_CONFIG,
      reactorConfig: REACTOR_CONFIG,
      routingConfig: ROUTING_CONFIG,
      brandContext: 'test',
      templateVars: { active_keywords: 'RWA, CLMM' },
    });

    expect(mockSearch).toHaveBeenCalledWith('Search for RWA, CLMM');
  });

  it('fails the source run when routeFn throws', async () => {
    const source: SourceConfig = {
      name: 'mentions',
      schedule: '*/15 * * * *',
      prompt: 'Search for Byreal',
    };

    const tweets = [makeTweet('1', 'Byreal mention')];
    const mockSearch = vi.fn().mockResolvedValue(tweets);
    const mockJudge = vi.fn().mockResolvedValue(
      new Map([['1', { alertLevel: 'orange', reasoning: 'Important mention' }]]),
    );
    const mockReactor = vi.fn().mockResolvedValue({
      suggestedAction: 'reply_supportive',
      tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }],
      replyAngle: 'be friendly',
    });

    await expect(
      processSource({
        source,
        searchFn: mockSearch,
        judgeFn: mockJudge,
        reactFn: mockReactor,
        routeFn: () => {
          throw new Error('db write failed');
        },
        judgeConfig: JUDGE_CONFIG,
        reactorConfig: REACTOR_CONFIG,
        routingConfig: ROUTING_CONFIG,
        brandContext: 'test',
        templateVars: {},
      }),
    ).rejects.toThrow('db write failed');
  });
});
