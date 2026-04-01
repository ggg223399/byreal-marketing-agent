import { describe, it, expect } from 'vitest';
import {
  ALERT_LEVELS,
  SUGGESTED_ACTIONS,
  TONES,
  type ProcessedSignal,
} from '../../engine/types.js';

describe('engine/types', () => {
  it('exports all AlertLevel values', () => {
    expect(ALERT_LEVELS).toEqual(['red', 'orange', 'yellow', 'none']);
  });

  it('exports all SuggestedAction values', () => {
    expect(SUGGESTED_ACTIONS).toEqual([
      'reply_supportive', 'qrt_positioning', 'collab_opportunity', 'like_only', 'explore_signal', 'escalate_internal', 'none',
    ]);
  });

  it('exports all Tone values', () => {
    expect(TONES).toEqual(['official', 'casual', 'meme', 'technical', 'empathetic']);
  });

  it('ProcessedSignal shape is valid', () => {
    const signal: ProcessedSignal = {
      tweet: { id: '1', author: '@test', content: 'hello', url: 'https://x.com/1', created_at: 1 },
      sourceName: 'mentions',
      alertLevel: 'orange',
      reasoning: 'test',
      suggestedAction: 'reply_supportive',
      tones: [{ id: 'casual', label: 'Casual', description: 'Friendly tone' }],
      replyAngle: 'be friendly',
    };
    expect(signal.alertLevel).toBe('orange');
    expect(signal.tones[0].id).toBe('casual');
  });
});
