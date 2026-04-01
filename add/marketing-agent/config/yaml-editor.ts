import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { parse, stringify } from 'yaml';

export function readYamlSafe(filePath: string): any {
  if (!existsSync(filePath)) {
    throw new Error(`YAML file not found: ${filePath}`);
  }
  return parse(readFileSync(filePath, 'utf-8'));
}

export function writeYamlSafe(filePath: string, data: unknown): void {
  if (existsSync(filePath)) {
    copyFileSync(filePath, filePath + '.bak');
  }
  writeFileSync(filePath, stringify(data, { lineWidth: 120 }), 'utf-8');
}
