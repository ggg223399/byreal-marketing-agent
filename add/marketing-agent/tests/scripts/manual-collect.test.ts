import { describe, expect, it } from 'vitest';

import {
  parseManualCollectArgs,
  resolveManualCollectSources,
} from '../../scripts/manual-collect.js';

describe('manual-collect CLI', () => {
  it('parses comma-separated and repeated source flags', () => {
    const options = parseManualCollectArgs([
      '--source', 'crisis,trend-keywords',
      '--source', 'explore-window',
      '--dry-run',
    ]);

    expect(options).toEqual({
      sourceNames: ['crisis', 'trend-keywords', 'explore-window'],
      dryRun: true,
      listOnly: false,
    });
  });

  it('defaults to all sources when none are requested', () => {
    expect(resolveManualCollectSources(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('deduplicates requested sources while preserving order', () => {
    expect(resolveManualCollectSources(['a', 'b', 'c'], ['b', 'a', 'b'])).toEqual(['b', 'a']);
  });

  it('throws for unknown sources', () => {
    expect(() => resolveManualCollectSources(['a', 'b'], ['c'])).toThrow('Unknown source(s): c');
  });
});
