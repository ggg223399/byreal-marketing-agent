import type { SchemaFieldEnum, SchemaFieldString, SchemaFieldArray } from './types.js';

export type OutputSchemaField = SchemaFieldEnum | SchemaFieldString | SchemaFieldArray;
export type OutputSchema = Record<string, OutputSchemaField>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function formatSchemaField(field: OutputSchemaField): string {
  if (field.type === 'enum') {
    return field.values.join('|');
  }
  if (field.type === 'array') {
    const item = Object.fromEntries(field.item_fields.map(f => [f, '<string>']));
    return `[${JSON.stringify(item)}, ...]  (${field.min_items}-${field.max_items} items)`;
  }
  return `<string max ${field.max_length} chars>`;
}

export function buildJsonExample(schema: OutputSchema): string {
  const example = Object.fromEntries(
    Object.entries(schema).map(([key, field]) => [key, formatSchemaField(field)])
  );

  return JSON.stringify(example);
}

function findBalancedJson(raw: string, openingChar: '{' | '[', fromIndex = 0): string | null {
  const closingChar = openingChar === '{' ? '}' : ']';
  const start = raw.indexOf(openingChar, fromIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === openingChar) {
      depth += 1;
      continue;
    }

    if (char === closingChar) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function extractFirstJsonValue(raw: string): string | null {
  const objectCandidate = findBalancedJson(raw, '{');
  const arrayCandidate = findBalancedJson(raw, '[');

  if (!objectCandidate) return arrayCandidate;
  if (!arrayCandidate) return objectCandidate;

  const objectIndex = raw.indexOf(objectCandidate);
  const arrayIndex = raw.indexOf(arrayCandidate);
  return objectIndex <= arrayIndex ? objectCandidate : arrayCandidate;
}

export function extractFirstJsonObject(raw: string): string | null {
  return findBalancedJson(raw, '{');
}

export function extractJsonObjects(raw: string): string[] {
  const results: string[] = [];
  let searchFrom = 0;

  while (searchFrom < raw.length) {
    const start = raw.indexOf('{', searchFrom);
    if (start === -1) break;

    const candidate = findBalancedJson(raw, '{', start);
    if (!candidate) break;

    results.push(candidate);
    searchFrom = start + 1;
  }

  return results;
}

export function validateFieldConfig(field: unknown): field is OutputSchemaField {
  if (!isRecord(field) || typeof field.type !== 'string') {
    return false;
  }

  if (field.type === 'enum') {
    return Array.isArray(field.values)
      && field.values.length > 0
      && field.values.every((value) => typeof value === 'string' && value.length > 0)
      && typeof field.description === 'string';
  }

  if (field.type === 'string') {
    return typeof field.max_length === 'number'
      && Number.isInteger(field.max_length)
      && field.max_length > 0
      && typeof field.description === 'string';
  }

  if (field.type === 'array') {
    return Array.isArray(field.item_fields)
      && field.item_fields.length > 0
      && field.item_fields.every((f) => typeof f === 'string')
      && typeof field.min_items === 'number'
      && typeof field.max_items === 'number'
      && typeof field.description === 'string';
  }

  return false;
}

export function validateObjectAgainstSchema<T extends OutputSchema>(
  schema: T,
  value: unknown,
): value is Record<keyof T, string> {
  return explainObjectSchemaMismatch(schema, value).length === 0;
}

export function explainObjectSchemaMismatch<T extends OutputSchema>(
  schema: T,
  value: unknown,
): string[] {
  if (!isRecord(value)) {
    return ['Expected an object'];
  }

  const errors: string[] = [];

  Object.entries(schema).forEach(([key, field]) => {
    const candidate = value[key];

    if (field.type === 'enum') {
      if (typeof candidate !== 'string') {
        errors.push(`${key}: expected enum string`);
        return;
      }
      if (!field.values.includes(candidate)) {
        errors.push(`${key}: expected one of ${field.values.join(', ')}`);
      }
      return;
    }

    if (field.type === 'string') {
      if (typeof candidate !== 'string') {
        errors.push(`${key}: expected string`);
        return;
      }
      if (candidate.length > field.max_length) {
        errors.push(`${key}: exceeds max length ${field.max_length}`);
      }
      return;
    }

    if (field.type === 'array') {
      if (!Array.isArray(candidate)) {
        errors.push(`${key}: expected array`);
        return;
      }
      if (candidate.length < field.min_items || candidate.length > field.max_items) {
        errors.push(`${key}: expected ${field.min_items}-${field.max_items} items`);
        return;
      }

      candidate.forEach((item, index) => {
        if (!isRecord(item)) {
          errors.push(`${key}[${index}]: expected object item`);
          return;
        }

        field.item_fields.forEach((fieldKey) => {
          if (typeof (item as Record<string, unknown>)[fieldKey] !== 'string') {
            errors.push(`${key}[${index}].${fieldKey}: expected string`);
          }
        });
      });
      return;
    }
  });

  return errors;
}
