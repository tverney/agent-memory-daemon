import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkSessionGate } from './sessionGate.js';

// Suppress logger stdout noise during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Requirements 1.3, 1.4: Session gate counts files with mtime > lastConsolidatedAt
// and passes when count >= minSessions
// ---------------------------------------------------------------------------
describe('checkSessionGate', () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-gate-'));
    sessionDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns { passed: false, count: 0 } when session directory does not exist', async () => {
    const result = await checkSessionGate('/nonexistent/path', 0, 1);
    expect(result).toEqual({ passed: false, count: 0 });
  });

  it('returns { passed: false, count: 0 } when session directory is empty', async () => {
    const result = await checkSessionGate(sessionDir, 0, 1);
    expect(result).toEqual({ passed: false, count: 0 });
  });

  it('counts only files with mtime newer than lastConsolidatedAt', async () => {
    const now = Date.now();
    const lastConsolidatedAt = now - 10_000; // 10 seconds ago

    // Create a file that is "new" (mtime = now, which is > lastConsolidatedAt)
    await fs.writeFile(path.join(sessionDir, 'new-session.jsonl'), 'data');

    // Create a file and backdate it to before lastConsolidatedAt
    const oldFile = path.join(sessionDir, 'old-session.jsonl');
    await fs.writeFile(oldFile, 'data');
    const oldDate = new Date(lastConsolidatedAt - 60_000);
    await fs.utimes(oldFile, oldDate, oldDate);

    const result = await checkSessionGate(sessionDir, lastConsolidatedAt, 1);
    expect(result.count).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('passes when count equals minSessions exactly', async () => {
    const lastConsolidatedAt = Date.now() - 60_000;

    await fs.writeFile(path.join(sessionDir, 'a.jsonl'), 'data');
    await fs.writeFile(path.join(sessionDir, 'b.jsonl'), 'data');
    await fs.writeFile(path.join(sessionDir, 'c.jsonl'), 'data');

    const result = await checkSessionGate(sessionDir, lastConsolidatedAt, 3);
    expect(result).toEqual({ passed: true, count: 3 });
  });

  it('fails when count is below minSessions', async () => {
    const lastConsolidatedAt = Date.now() - 60_000;

    await fs.writeFile(path.join(sessionDir, 'a.jsonl'), 'data');
    await fs.writeFile(path.join(sessionDir, 'b.jsonl'), 'data');

    const result = await checkSessionGate(sessionDir, lastConsolidatedAt, 5);
    expect(result.count).toBe(2);
    expect(result.passed).toBe(false);
  });

  it('ignores subdirectories (only counts files)', async () => {
    const lastConsolidatedAt = Date.now() - 60_000;

    await fs.writeFile(path.join(sessionDir, 'session.jsonl'), 'data');
    await fs.mkdir(path.join(sessionDir, 'subdir'));

    const result = await checkSessionGate(sessionDir, lastConsolidatedAt, 1);
    expect(result.count).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('passes with minSessions = 0 even when directory is empty', async () => {
    const result = await checkSessionGate(sessionDir, Date.now(), 0);
    expect(result).toEqual({ passed: true, count: 0 });
  });
});
