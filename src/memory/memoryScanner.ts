import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';
import { parseFrontmatter } from './frontmatter.js';
import type { MemoryHeader } from '../types.js';

const MAX_MEMORIES = 200;
const INDEX_FILENAME = 'MEMORY.md';

export async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryHeader[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    log('warn', 'scanner:readdir-failed', { memoryDir });
    return [];
  }

  const mdFiles = entries.filter(
    (f) => f.endsWith('.md') && f !== INDEX_FILENAME,
  );

  const headers: MemoryHeader[] = [];

  for (const file of mdFiles) {
    if (signal?.aborted) break;

    const filePath = path.join(memoryDir, file);
    try {
      const [stat, raw] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(filePath, 'utf-8'),
      ]);

      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      headers.push({
        path: file,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        type: parsed.frontmatter.type,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      log('warn', 'scanner:file-read-failed', { file });
    }
  }

  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORIES);
}

export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const typeTag = m.type ? ` [${m.type}]` : '';
      return `${m.path}${typeTag}: ${m.name} — ${m.description}`;
    })
    .join('\n');
}
