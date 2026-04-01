import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/claude-sdk.js', () => ({
  callClaudeText: vi.fn(),
}));

import { callClaudeText } from '../../../src/claude-sdk.js';
import { generateSingleToneDraft, loadGeneratorRuntimeConfig } from '../../generator/draft.js';
import type { PipelineSignal } from '../../types/index.js';

const mockedCallClaudeText = vi.mocked(callClaudeText);

const SIGNAL: PipelineSignal = {
  id: 1,
  tweetId: 'sig-1',
  author: '@alice',
  content: 'Byreal is live',
  url: 'https://x.com/alice/status/1',
  pipeline: 'mentions',
  pipelines: ['mentions'],
  actionType: 'reply',
  angle: 'Say thanks',
  tones: [{ id: 'casual', label: 'Casual', description: 'Friendly tone' }],
  reason: 'Test reason',
  sourceAdapter: 'mock',
  resolvedChannels: ['needs-reply'],
  createdAt: Math.floor(Date.now() / 1000),
  sourceName: 'mentions',
  alertLevel: 'orange',
  suggestedAction: 'reply_supportive',
  v5Tone: 'casual',
  replyAngle: 'Say thanks',
  judgeReasoning: 'Relevant mention',
};

describe('generator/draft', () => {
  beforeEach(() => {
    mockedCallClaudeText.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.MOCK_DRAFT_RESPONSE;
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('loads runtime config from generator.yaml before generating drafts', async () => {
    mockedCallClaudeText.mockResolvedValue('Thanks for the mention.');
    loadGeneratorRuntimeConfig('marketing-agent/tests/fixtures');

    const draft = await generateSingleToneDraft(SIGNAL, 'casual');

    expect(draft).toBe('Thanks for the mention.');
    expect(mockedCallClaudeText).toHaveBeenCalledTimes(1);
    expect(mockedCallClaudeText.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-4-5-20250514',
      temperature: 0.7,
      maxTokens: 400,
    });
  });
});
