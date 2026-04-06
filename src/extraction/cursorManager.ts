import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../logger.js';
import type { SessionCursor } from '../types.js';

export const CURSOR_FILENAME = '.extraction-cursor';
export const SESSION_CURSOR_FILENAME = '.extraction-session-cursor';

/** File extensions considered as session files. */
const SESSION_EXTENSIONS = new Set(['.md', '.txt', '.jsonl']);

/**
 * Read the extraction cursor from the memory directory.
 *
 * The cursor file is a plain text file containing a single line:
 * the Unix timestamp in milliseconds of the last successful extraction.
 *
 * Returns 0 when the file does not exist (Req 2.6) or contains
 * non-numeric content (Req 8.4), with a warning log for corrupt files.
 */
export async function readExtractionCursor(memoryDir: string): Promise<number> {
  const cursorPath = path.join(memoryDir, CURSOR_FILENAME);

  try {
    const content = await fs.readFile(cursorPath, 'utf-8');
    const parsed = Number(content.trim());

    if (!Number.isFinite(parsed) || parsed < 0) {
      log('warn', 'cursor.corrupt', {
        path: cursorPath,
        content: content.trim(),
      });
      return 0;
    }

    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

/**
 * Write the extraction cursor to the memory directory.
 *
 * Persists the given timestamp (in milliseconds) so it survives
 * daemon restarts (Req 2.5, 8.1, 8.3).
 *
 * Also snapshots session file sizes into a per-session cursor stored
 * in the session directory (sibling `sessions` folder by default, or
 * the explicitly provided `sessionDir`). This enables content-aware
 * change detection in `evaluateExtractionTrigger`.
 */
export async function writeExtractionCursor(
  memoryDir: string,
  timestampMs: number,
  sessionDir?: string,
): Promise<void> {
  const cursorPath = path.join(memoryDir, CURSOR_FILENAME);
  await fs.writeFile(cursorPath, String(timestampMs) + '\n', 'utf-8');

  // Attempt to snapshot session file sizes for per-session cursor tracking.
  const resolvedSessionDir = sessionDir ?? path.join(path.dirname(memoryDir), 'sessions');
  try {
    const entries = await fs.readdir(resolvedSessionDir);
    const cursor: SessionCursor = {};
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (!SESSION_EXTENSIONS.has(ext)) continue;
      const fullPath = path.join(resolvedSessionDir, entry);
      try {
        const fileStat = await fs.stat(fullPath);
        if (fileStat.isFile()) {
          cursor[entry] = { offset: fileStat.size, mtimeMs: fileStat.mtimeMs };
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
    if (Object.keys(cursor).length > 0) {
      await writeSessionCursor(resolvedSessionDir, cursor);
    }
  } catch {
    // Session directory not found or not accessible — skip session cursor snapshot
  }
}


/**
 * Read the per-session extraction cursor from the memory directory.
 *
 * The session cursor is a JSON file mapping session filenames to their
 * last-processed offset and mtime. If the file does not exist, returns
 * an empty map. If the file contains a plain number (legacy format),
 * returns an empty map to treat it as a fresh start.
 */
export async function readSessionCursor(memoryDir: string): Promise<SessionCursor> {
  const cursorPath = path.join(memoryDir, SESSION_CURSOR_FILENAME);

  try {
    const content = await fs.readFile(cursorPath, 'utf-8');
    const trimmed = content.trim();

    // Legacy migration: if the file contains a plain number, treat as fresh start
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      log('info', 'session-cursor:legacy-migration', { path: cursorPath });
      return {};
    }

    const parsed = JSON.parse(trimmed) as unknown;

    // Validate it's a plain object
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log('warn', 'session-cursor:corrupt', { path: cursorPath });
      return {};
    }

    return parsed as SessionCursor;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    // Corrupt JSON
    if (err instanceof SyntaxError) {
      log('warn', 'session-cursor:corrupt-json', { path: cursorPath });
      return {};
    }
    throw err;
  }
}

/**
 * Write the per-session extraction cursor to the memory directory.
 */
export async function writeSessionCursor(
  memoryDir: string,
  cursor: SessionCursor,
): Promise<void> {
  const cursorPath = path.join(memoryDir, SESSION_CURSOR_FILENAME);
  await fs.writeFile(cursorPath, JSON.stringify(cursor, null, 2) + '\n', 'utf-8');
}

/**
 * Scan the session directory and return only sessions that are new
 * (not in cursor) or modified (mtime changed since cursor entry).
 *
 * Sessions that are in the cursor with unchanged mtime are considered
 * already processed and are excluded.
 */
export async function getUnprocessedSessions(
  sessionDir: string,
  cursor: SessionCursor,
): Promise<string[]> {
  let entries: string[];

  try {
    entries = await fs.readdir(sessionDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const unprocessed: string[] = [];

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!SESSION_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(sessionDir, entry);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;

      const cursorEntry = cursor[entry];
      if (!cursorEntry) {
        // New session — not in cursor
        unprocessed.push(entry);
      } else if (stat.mtimeMs !== cursorEntry.mtimeMs) {
        // Modified session — mtime changed
        unprocessed.push(entry);
      }
      // Otherwise: already processed and unchanged, skip
    } catch {
      // Skip files that can't be stat'd (e.g., deleted between readdir and stat)
    }
  }

  return unprocessed;
}
