import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexEntry } from '../types.js';
import { log } from '../logger.js';

export const ENTRYPOINT_NAME = 'MEMORY.md';
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

const INDEX_LINE_RE = /^- \[(.+?)\]\((.+?)\)\s*—\s*(.*)$/;
const MAX_ENTRY_CHARS = 150;
const VERBOSE_THRESHOLD = 200;

/**
 * Parse MEMORY.md lines into IndexEntry[].
 * Skips blank lines and lines that don't match the expected format.
 */
export async function readIndex(memoryDir: string): Promise<IndexEntry[]> {
  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const entries: IndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = INDEX_LINE_RE.exec(trimmed);
    if (match) {
      entries.push({ title: match[1], file: match[2], description: match[3].trim() });
    } else {
      log('warn', 'index_parse_skip', { line: trimmed });
    }
  }
  return entries;
}


/**
 * Format a single IndexEntry as a markdown list item.
 * Truncates to MAX_ENTRY_CHARS (150) if needed.
 */
export function formatIndexEntry(entry: IndexEntry): string {
  const full = `- [${entry.title}](${entry.file}) — ${entry.description}`;
  if (full.length <= MAX_ENTRY_CHARS) return full;

  // Shorten description to fit within the limit
  const prefix = `- [${entry.title}](${entry.file}) — `;
  const available = MAX_ENTRY_CHARS - prefix.length - 3; // 3 for "..."
  if (available > 0) {
    return prefix + entry.description.slice(0, available) + '...';
  }
  // If even the prefix is too long, just truncate the whole thing
  return full.slice(0, MAX_ENTRY_CHARS - 3) + '...';
}

/**
 * Format entries and write them to MEMORY.md.
 */
export async function writeIndex(
  memoryDir: string,
  entries: IndexEntry[],
): Promise<void> {
  const lines = entries.map(formatIndexEntry);
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  await writeFile(indexPath, content, 'utf-8');
  log('info', 'index_written', { entries: entries.length, bytes: Buffer.byteLength(content, 'utf-8') });
}

/**
 * Enforce line and byte budget on raw index content.
 *
 * 1. Demote verbose lines (>200 chars) by truncating them.
 * 2. Trim to maxLines.
 * 3. Trim to maxBytes.
 * 4. Append a truncation warning if anything was cut.
 */
export function truncateIndexContent(
  raw: string,
  maxLines: number,
  maxBytes: number,
): { content: string; truncated: boolean; reason?: 'lines' | 'bytes' } {
  let lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Step 1: demote verbose entries (>200 chars)
  lines = lines.map((line) => {
    if (line.length > VERBOSE_THRESHOLD) {
      return line.slice(0, VERBOSE_THRESHOLD - 3) + '...';
    }
    return line;
  });

  let truncated = false;
  let reason: 'lines' | 'bytes' | undefined;

  // Step 2: enforce line limit
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
    reason = 'lines';
  }

  // Step 3: enforce byte limit
  let content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    // Remove lines from the end until we fit
    while (lines.length > 0) {
      const candidate = lines.join('\n') + '\n';
      // Reserve space for the warning line
      const warningLine = '\n<!-- Truncated: index exceeded byte limit -->\n';
      if (Buffer.byteLength(candidate + warningLine, 'utf-8') <= maxBytes) {
        break;
      }
      lines.pop();
    }
    truncated = true;
    reason = 'bytes';
    content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }

  // Step 4: append warning if truncated
  if (truncated) {
    const warning =
      reason === 'lines'
        ? `<!-- Truncated: index exceeded ${maxLines}-line limit -->`
        : `<!-- Truncated: index exceeded ${maxBytes}-byte limit -->`;
    content = content + warning + '\n';
  }

  return { content, truncated, reason };
}
