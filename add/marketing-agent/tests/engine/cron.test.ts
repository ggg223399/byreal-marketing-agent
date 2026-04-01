import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCronJobs, stopAllJobs, validateCronExpression } from '../../engine/cron.js';
import type { SourceConfig } from '../../engine/types.js';

describe('cron', () => {
  let jobs: ReturnType<typeof buildCronJobs> = [];

  afterEach(() => {
    stopAllJobs(jobs);
    jobs = [];
  });

  describe('validateCronExpression', () => {
    it('accepts valid expressions', () => {
      expect(validateCronExpression('*/15 * * * *')).toBe(true);
      expect(validateCronExpression('0 * * * *')).toBe(true);
      expect(validateCronExpression('*/5 * * * *')).toBe(true);
    });

    it('rejects invalid expressions', () => {
      expect(validateCronExpression('not-a-cron')).toBe(false);
      expect(validateCronExpression('')).toBe(false);
    });
  });

  describe('buildCronJobs', () => {
    it('creates one cron job per source', () => {
      const sources: SourceConfig[] = [
        { name: 'mentions', schedule: '*/15 * * * *', prompt: 'test' },
        { name: 'crisis', schedule: '*/5 * * * *', prompt: 'test' },
      ];
      const handler = vi.fn().mockResolvedValue(undefined);
      jobs = buildCronJobs(sources, handler);
      expect(jobs).toHaveLength(2);
      expect(jobs[0].name).toBe('mentions');
      expect(jobs[0].schedule).toBe('*/15 * * * *');
      expect(jobs[1].name).toBe('crisis');
    });

    it('throws on invalid cron expression', () => {
      const sources: SourceConfig[] = [
        { name: 'bad', schedule: 'not-a-cron', prompt: 'test' },
      ];
      expect(() => buildCronJobs(sources, vi.fn())).toThrow('Invalid cron');
    });

    it('creates tasks in non-scheduled mode', () => {
      const sources: SourceConfig[] = [
        { name: 'test', schedule: '*/15 * * * *', prompt: 'test' },
      ];
      jobs = buildCronJobs(sources, vi.fn().mockResolvedValue(undefined));
      expect(jobs[0].task).toBeDefined();
    });
  });
});
