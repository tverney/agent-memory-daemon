import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../logger.js';
import type { ExtractionTriggerResult } from '../types.js';

/** File extensions considered as session files (Req 2.4). */
const SESSION_EXTENSIONS = new Set(['.md', '.txt', '.jsonl']);

/**
 * Scan the session directory for files modified since the cursor timestamp.
 *
 * Returns `{ triggered: true, modifiedFiles }` when at least one session file
 * has an mtime greater than `cursorTimestamp`, otherwise returns
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

  const modifiedFiles: string[] = [];

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!SESSION_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(sessionDir, entry);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && stat.mtimeMs > cursorTimestamp) {
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
