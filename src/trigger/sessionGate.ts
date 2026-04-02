import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../logger.js';

/**
 * Check whether enough recent sessions exist to justify a consolidation pass.
 *
 * Scans sessionDirectory for files with mtime > lastConsolidatedAt and returns
 * whether the count meets or exceeds minSessions.
 *
 * If the session directory does not exist, treats it as 0 sessions (does not throw).
 *
 * Validates: Requirements 1.3, 1.4
 */
export async function checkSessionGate(
  sessionDirectory: string,
  lastConsolidatedAt: number,
  minSessions: number,
): Promise<{ passed: boolean; count: number }> {
  let entries: string[];

  try {
    entries = await fs.readdir(sessionDirectory);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log('info', 'trigger.session_gate', {
        sessionDirectory,
        lastConsolidatedAt,
        minSessions,
        count: 0,
        passed: false,
        reason: 'directory_not_found',
      });
      return { passed: false, count: 0 };
    }
    throw err;
  }

  let count = 0;

  for (const entry of entries) {
    const fullPath = path.join(sessionDirectory, entry);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && stat.mtimeMs > lastConsolidatedAt) {
        count++;
      }
    } catch {
      // Skip files that can't be stat'd (e.g., deleted between readdir and stat)
    }
  }

  const passed = count >= minSessions;

  log('info', 'trigger.session_gate', {
    sessionDirectory,
    lastConsolidatedAt,
    minSessions,
    count,
    passed,
  });

  return { passed, count };
}
