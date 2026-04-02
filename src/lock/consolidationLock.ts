import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../logger.js';
import type { LockState } from '../types.js';

export const LOCK_FILENAME = '.consolidate-lock';

/**
 * Check whether a process with the given PID is alive.
 * Uses process.kill(pid, 0) which sends no signal but throws if the process doesn't exist.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current state of the lock file.
 *
 * Returns a LockState describing whether the lock exists, who holds it,
 * whether the holder is alive, and whether the lock is stale.
 */
export async function readLockState(
  memoryDir: string,
  staleLockThresholdMs: number,
): Promise<LockState> {
  const lockPath = path.join(memoryDir, LOCK_FILENAME);

  try {
    const [content, stat] = await Promise.all([
      fs.readFile(lockPath, 'utf-8'),
      fs.stat(lockPath),
    ]);

    const pid = parseInt(content.trim(), 10);
    const holderPid = Number.isNaN(pid) ? null : pid;
    const mtime = stat.mtimeMs;
    const holderAlive = holderPid !== null && isPidAlive(holderPid);
    const isStale = Date.now() - mtime >= staleLockThresholdMs;

    return { exists: true, holderPid, mtime, isStale, holderAlive };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, holderPid: null, mtime: 0, isStale: false, holderAlive: false };
    }
    throw err;
  }
}

/**
 * Attempt to acquire the consolidation lock.
 *
 * Strategy:
 * 1. Read current lock state
 * 2. If lock exists and holder is alive and lock is not stale → cannot acquire
 * 3. If lock is stale (Req 2.7) or holder is dead (Req 2.5) → reclaim
 * 4. Write our PID to the lock file
 * 5. Re-read to detect race condition (Req 2.6) — yield if PID mismatch
 *
 * Returns { acquired: true, priorMtime } on success, { acquired: false, priorMtime: 0 } on failure.
 */
export async function tryAcquireLock(
  memoryDir: string,
  staleLockThresholdMs: number,
): Promise<{ acquired: boolean; priorMtime: number }> {
  const lockPath = path.join(memoryDir, LOCK_FILENAME);
  const myPid = process.pid;

  // Step 1: Read current lock state
  const state = await readLockState(memoryDir, staleLockThresholdMs);
  const priorMtime = state.mtime;

  if (state.exists) {
    // Lock exists — check if we can reclaim it
    if (state.isStale) {
      // Req 2.7: Reclaim stale lock regardless of holder PID status
      log('info', 'lock.reclaim_stale', {
        holderPid: state.holderPid,
        staleSinceMs: Date.now() - state.mtime,
      });
    } else if (!state.holderAlive) {
      // Req 2.5: Holder PID is dead, reclaim
      log('info', 'lock.reclaim_dead_holder', { holderPid: state.holderPid });
    } else {
      // Lock is held by a live process and is not stale — cannot acquire
      log('info', 'lock.held_by_other', { holderPid: state.holderPid });
      return { acquired: false, priorMtime: 0 };
    }
  }

  // Step 2: Write our PID to the lock file (Req 2.1)
  await fs.writeFile(lockPath, String(myPid) + '\n', 'utf-8');

  // Step 3: Re-read to detect race (Req 2.6)
  const verification = await readLockState(memoryDir, staleLockThresholdMs);

  if (verification.holderPid !== myPid) {
    // Another process won the race — yield
    log('warn', 'lock.race_detected', {
      myPid,
      winnerPid: verification.holderPid,
    });
    return { acquired: false, priorMtime: 0 };
  }

  log('info', 'lock.acquired', { pid: myPid });
  return { acquired: true, priorMtime };
}

/**
 * Release the lock after a successful consolidation pass.
 *
 * Updates the lock file's mtime to now, representing the completion timestamp (Req 2.2).
 * The lock file is left in place — its mtime serves as the "last consolidated at" marker.
 */
export async function releaseLock(memoryDir: string): Promise<void> {
  const lockPath = path.join(memoryDir, LOCK_FILENAME);
  const now = new Date();

  // Touch the file: update atime and mtime to now
  await fs.utimes(lockPath, now, now);

  log('info', 'lock.released', { mtime: now.toISOString() });
}

/**
 * Roll back the lock after a failed consolidation pass.
 *
 * Restores the lock file's mtime to its pre-acquisition value (Req 2.3),
 * so the next trigger evaluation sees the original "last consolidated at" timestamp.
 */
export async function rollbackLock(
  memoryDir: string,
  priorMtime: number,
): Promise<void> {
  const lockPath = path.join(memoryDir, LOCK_FILENAME);
  const priorDate = new Date(priorMtime);

  await fs.utimes(lockPath, priorDate, priorDate);

  log('info', 'lock.rolled_back', { restoredMtime: priorDate.toISOString() });
}
