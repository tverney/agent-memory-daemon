import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../logger.js';
import { readSessionCursor } from './cursorManager.js';
import type { ExtractionTriggerResult } from '../types.js';

/** File extensions considered as session files (Req 2.4). */
const SESSION_EXTENSIONS = new Set(['.md', '.txt', '.jsonl']);

/**
 * Scan the session directory for files modified since the cursor timestamp.
 *
 * Uses per-session cursor tracking (stored in the session directory) to
 * detect content-level changes. A file whose mtime is newer than the cursor
 * but whose size matches the recorded offset is considered unchanged
 * (e.g., only touched/accessed, not actually modified) and is excluded.
 *
 * Returns `{ triggered: true, modifiedFiles }` when at least one session file
 * has genuinely new content, otherwise returns
 * `{ triggered: false, modifiedFiles: [] }`.
 *
 * If the session directory does not exist, returns not-triggered (no throw).
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */
export async function evaluateExtractionTrigger(
  sessionDir: string,
  cursorTimestamp: number,
): Promise<ExtractionTriggerResult> {
  let entries: string[];

  try {
    entries = await fs.readdir(sessionDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log('info', 'extraction.trigger', {
        sessionDir,
        cursorTimestamp,
        triggered: false,
        reason: 'directory_not_found',
      });
      return { triggered: false, modifiedFiles: [] };
    }
    throw err;
  }

  // Read per-session cursor from the session directory for content-aware filtering
  const sessionCursor = await readSessionCursor(sessionDir);

  const modifiedFiles: string[] = [];

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!SESSION_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(sessionDir, entry);
    try {
      const fileStat = await fs.stat(fullPath);
      if (!fileStat.isFile()) continue;

      if (fileStat.mtimeMs > cursorTimestamp) {
        // Check per-session cursor: if the file's size matches the recorded
        // offset, the content hasn't actually changed (just touched/accessed).
        const cursorEntry = sessionCursor[entry];
        if (cursorEntry && fileStat.size === cursorEntry.offset) {
          // Content unchanged — skip this file
          continue;
        }
        modifiedFiles.push(entry);
      }
    } catch {
      // Skip files that can't be stat'd (e.g., deleted between readdir and stat)
    }
  }

  const triggered = modifiedFiles.length > 0;

  log('info', 'extraction.trigger', {
    sessionDir,
    cursorTimestamp,
    triggered,
    modifiedCount: modifiedFiles.length,
  });

  return { triggered, modifiedFiles };
}
