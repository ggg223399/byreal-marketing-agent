import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const SOURCE_ROOT = path.join(PROJECT_ROOT, 'dist', 'marketing-agent');
const TARGET_ROOT = path.join(PROJECT_ROOT, 'marketing-agent');
const COMPILED_EXTENSIONS = new Set(['.js', '.js.map', '.d.ts', '.d.ts.map']);

function hasCompiledExtension(fileName) {
  for (const ext of COMPILED_EXTENSIONS) {
    if (fileName.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkCompiledFiles(rootDir, currentDir = rootDir, out = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkCompiledFiles(rootDir, absolutePath, out);
      continue;
    }
    if (!hasCompiledExtension(entry.name)) {
      continue;
    }
    out.push(path.relative(rootDir, absolutePath));
  }
  return out;
}

async function syncCompiledOutput() {
  if (!(await exists(SOURCE_ROOT))) {
    throw new Error(`Build output not found: ${SOURCE_ROOT}`);
  }

  const sourceRelPaths = await walkCompiledFiles(SOURCE_ROOT);
  const sourcePathSet = new Set(sourceRelPaths);

  let copied = 0;
  for (const relPath of sourceRelPaths) {
    const src = path.join(SOURCE_ROOT, relPath);
    const dst = path.join(TARGET_ROOT, relPath);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    copied += 1;
  }

  let removed = 0;
  if (await exists(TARGET_ROOT)) {
    const targetRelPaths = await walkCompiledFiles(TARGET_ROOT);
    for (const relPath of targetRelPaths) {
      if (sourcePathSet.has(relPath)) {
        continue;
      }
      await fs.rm(path.join(TARGET_ROOT, relPath), { force: true });
      removed += 1;
    }
  }

  console.log(`[sync-build-output] copied ${copied} files, removed ${removed} stale files`);
}

await syncCompiledOutput();
