import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../logger.js';

export const CURSOR_FILENAME = '.extraction-cursor';

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
 */
export async function writeExtractionCursor(
  memoryDir: string,
  timestampMs: number,
): Promise<void> {
  const cursorPath = path.join(memoryDir, CURSOR_FILENAME);
  await fs.writeFile(cursorPath, String(timestampMs) + '\n', 'utf-8');
}
