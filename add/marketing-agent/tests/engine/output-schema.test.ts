import { describe, it, expect } from 'vitest';
import {
  buildJsonExample,
  explainObjectSchemaMismatch,
  validateObjectAgainstSchema,
  validateFieldConfig,
} from '../../engine/output-schema.js';

describe('output-schema', () => {
  describe('array field type', () => {
    const schema = {
      suggestedAction: { type: 'enum' as const, values: ['reply_supportive', 'none'], description: 'Action' },
      tones: {
        type: 'array' as const,
        min_items: 1,
        max_items: 4,
        item_fields: ['id', 'label', 'description'],
        description: 'Tone options',
      },
    };

    it('validates array with correct items', () => {
      expect(validateObjectAgainstSchema(schema, {
        suggestedAction: 'reply_supportive',
        tones: [
          { id: 'casual', label: 'Casual', description: 'Friendly chat' },
          { id: 'meme', label: 'Meme', description: 'CT degen style' },
        ],
      })).toBe(true);
    });

    it('rejects empty array when min_items=1', () => {
      expect(validateObjectAgainstSchema(schema, {
        suggestedAction: 'reply_supportive',
        tones: [],
      })).toBe(false);
    });

    it('rejects array exceeding max_items', () => {
      expect(validateObjectAgainstSchema(schema, {
        suggestedAction: 'reply_supportive',
        tones: [
          { id: 'a', label: 'A', description: 'A' },
          { id: 'b', label: 'B', description: 'B' },
          { id: 'c', label: 'C', description: 'C' },
          { id: 'd', label: 'D', description: 'D' },
          { id: 'e', label: 'E', description: 'E' },
        ],
      })).toBe(false);
    });

    it('rejects item missing required field', () => {
      expect(validateObjectAgainstSchema(schema, {
        suggestedAction: 'reply_supportive',
        tones: [{ id: 'casual', label: 'Casual' }],
      })).toBe(false);
    });

    it('rejects non-array value', () => {
      expect(validateObjectAgainstSchema(schema, {
        suggestedAction: 'reply_supportive',
        tones: 'casual',
      })).toBe(false);
    });
  });

  describe('validateFieldConfig for array', () => {
    it('accepts valid array field config', () => {
      expect(validateFieldConfig({
        type: 'array',
        min_items: 1,
        max_items: 4,
        item_fields: ['id', 'label', 'description'],
        description: 'Tones',
      })).toBe(true);
    });

    it('rejects array field with empty item_fields', () => {
      expect(validateFieldConfig({
        type: 'array',
        min_items: 1,
        max_items: 4,
        item_fields: [],
        description: 'Tones',
      })).toBe(false);
    });
  });

  describe('buildJsonExample for array', () => {
    it('shows array example format', () => {
      const schema = {
        tones: {
          type: 'array' as const,
          min_items: 1,
          max_items: 3,
          item_fields: ['id', 'label', 'description'],
          description: 'Tones',
        },
      };
      const example = buildJsonExample(schema);
      expect(example).toContain('[{');
      expect(example).toContain('id');
    });
  });

  describe('explainObjectSchemaMismatch', () => {
    it('returns field-level errors for invalid values', () => {
      const schema = {
        action: { type: 'enum' as const, values: ['reply', 'skip'], description: 'Action' },
        reason: { type: 'string' as const, max_length: 5, description: 'Reason' },
      };

      expect(explainObjectSchemaMismatch(schema, {
        action: 'invalid',
        reason: 'too long',
      })).toEqual([
        'action: expected one of reply, skip',
        'reason: exceeds max length 5',
      ]);
    });
  });

  // Ensure existing enum/string validation still works
  describe('existing field types unchanged', () => {
    it('validates enum field', () => {
      const schema = {
        action: { type: 'enum' as const, values: ['reply', 'skip'], description: 'Action' },
      };
      expect(validateObjectAgainstSchema(schema, { action: 'reply' })).toBe(true);
      expect(validateObjectAgainstSchema(schema, { action: 'invalid' })).toBe(false);
    });

    it('validates string field', () => {
      const schema = {
        reason: { type: 'string' as const, max_length: 10, description: 'Reason' },
      };
      expect(validateObjectAgainstSchema(schema, { reason: 'short' })).toBe(true);
      expect(validateObjectAgainstSchema(schema, { reason: 'x'.repeat(11) })).toBe(false);
    });
  });
});
