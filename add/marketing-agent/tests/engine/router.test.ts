import { describe, it, expect } from 'vitest';
import { resolveChannels } from '../../engine/router.js';
import type { RoutingConfig, ProcessedSignal, RawTweet } from '../../engine/types.js';

const ROUTING: RoutingConfig = {
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
    dedup_key: ['tweet_id', 'channel'],
  },
};

function makeSignal(overrides: Partial<ProcessedSignal> = {}): ProcessedSignal {
  const tweet: RawTweet = { id: '1', author: '@test', content: 'test', url: 'https://x.com/1', created_at: 1 };
  return {
    tweet,
    sourceName: 'test',
    alertLevel: 'orange',
    reasoning: 'test',
    suggestedAction: 'reply_supportive',
    tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }],
    replyAngle: 'be nice',
    ...overrides,
  };
}

describe('router', () => {
  it('routes reply_supportive to needs-reply', () => {
    const channels = resolveChannels(makeSignal(), ROUTING);
    expect(channels).toEqual(['needs-reply']);
  });

  it('routes qrt_positioning to needs-qrt', () => {
    const channels = resolveChannels(
      makeSignal({ suggestedAction: 'qrt_positioning' }),
      ROUTING
    );
    expect(channels).toEqual(['needs-qrt']);
  });

  it('routes collab_opportunity to collab-opportunities', () => {
    const channels = resolveChannels(
      makeSignal({ suggestedAction: 'collab_opportunity' }),
      ROUTING
    );
    expect(channels).toEqual(['collab-opportunities']);
  });

  it('routes escalate_internal to escalation', () => {
    const channels = resolveChannels(
      makeSignal({ alertLevel: 'red', suggestedAction: 'escalate_internal' }),
      ROUTING
    );
    expect(channels).toEqual(['escalation']);
  });

  it('routes like_only to engagement', () => {
    const channels = resolveChannels(
      makeSignal({ suggestedAction: 'like_only' }),
      ROUTING
    );
    expect(channels).toEqual(['engagement']);
  });

  it('routes explore_signal to trending', () => {
    const channels = resolveChannels(
      makeSignal({ suggestedAction: 'explore_signal' }),
      ROUTING
    );
    expect(channels).toEqual(['trending']);
  });

  it('routes suggestedAction=none to default noise', () => {
    const channels = resolveChannels(
      makeSignal({ suggestedAction: 'none' }),
      ROUTING
    );
    expect(channels).toEqual(['noise']);
  });

  it('falls back to default when no match', () => {
    const routing: RoutingConfig = {
      routing: {
        default: { channel: 'noise' },
        routes: [
          { match: { alertLevel: 'red' }, channel: 'tier1' },
        ],
      },
    };
    const channels = resolveChannels(makeSignal({ alertLevel: 'yellow' }), routing);
    expect(channels).toEqual(['noise']);
  });

  it('handles match_not', () => {
    const routing: RoutingConfig = {
      routing: {
        default: { channel: 'noise' },
        routes: [
          { match_not: { suggestedAction: 'none' }, channel: 'actionable' },
        ],
      },
    };
    const channels = resolveChannels(makeSignal({ suggestedAction: 'reply_supportive' }), routing);
    expect(channels).toEqual(['actionable']);

    const channels2 = resolveChannels(makeSignal({ suggestedAction: 'none' }), routing);
    expect(channels2).toEqual(['noise']);
  });

  it('handles multi-field AND match', () => {
    const routing: RoutingConfig = {
      routing: {
        default: { channel: 'noise' },
        routes: [
          { match: { alertLevel: 'red', suggestedAction: 'escalate_internal' }, channel: 'critical-escalation' },
          { match: { alertLevel: 'red' }, channel: 'urgent' },
        ],
      },
    };
    // Both fields match
    const ch1 = resolveChannels(makeSignal({ alertLevel: 'red', suggestedAction: 'escalate_internal' }), routing);
    expect(ch1).toEqual(['critical-escalation']);

    // Only alertLevel matches - second route
    const ch2 = resolveChannels(makeSignal({ alertLevel: 'red', suggestedAction: 'reply_supportive' }), routing);
    expect(ch2).toEqual(['urgent']);
  });

  it('continue: true collects multiple channels', () => {
    const routing: RoutingConfig = {
      routing: {
        default: { channel: 'noise' },
        routes: [
          { match: { alertLevel: 'red' }, channel: 'urgent', continue: true },
          { match: { suggestedAction: 'escalate_internal' }, channel: 'escalation' },
        ],
      },
    };
    const channels = resolveChannels(
      makeSignal({ alertLevel: 'red', suggestedAction: 'escalate_internal' }),
      routing
    );
    expect(channels).toEqual(['urgent', 'escalation']);
  });
});
