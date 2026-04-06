import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, writeFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readExtractionCursor, writeExtractionCursor, readSessionCursor, writeSessionCursor, getUnprocessedSessions } from './cursorManager.js';
import { log } from '../logger.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

describe('Cursor manager property tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `cursor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Feature: memory-extraction, Property 5: Cursor read/write round-trip
  it('Property 5: Cursor read/write round-trip', async () => {
    // Validates: Requirements 2.5, 8.3, 8.4
    const timestampArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

    await fc.assert(
      fc.asyncProperty(timestampArb, async (ts) => {
        await writeExtractionCursor(tmpDir, ts);
        const read = await readExtractionCursor(tmpDir);
        expect(read).toBe(ts);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Cursor manager edge case unit tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = join(tmpdir(), `cursor-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Validates: Requirements 2.6
  it('returns 0 when cursor file does not exist', async () => {
    const result = await readExtractionCursor(tmpDir);
    expect(result).toBe(0);
  });

  // Validates: Requirements 2.6
  it('returns 0 and logs warning when file contains non-numeric content', async () => {
    await writeFile(join(tmpDir, '.extraction-cursor'), 'not-a-number\n', 'utf-8');

    const result = await readExtractionCursor(tmpDir);

    expect(result).toBe(0);
    expect(log).toHaveBeenCalledWith('warn', 'cursor.corrupt', {
      path: join(tmpDir, '.extraction-cursor'),
      content: 'not-a-number',
    });
  });
});


describe('Session cursor read/write tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = join(tmpdir(), `session-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when session cursor file does not exist', async () => {
    const result = await readSessionCursor(tmpDir);
    expect(result).toEqual({});
  });

  it('round-trips a session cursor through write and read', async () => {
    const cursor = {
      'session-001.md': { offset: 1024, mtimeMs: 1700000000000 },
      'session-002.txt': { offset: 512, mtimeMs: 1700001000000 },
    };
    await writeSessionCursor(tmpDir, cursor);
    const result = await readSessionCursor(tmpDir);
    expect(result).toEqual(cursor);
  });

  it('returns empty map when file contains a plain number (legacy migration)', async () => {
    await writeFile(join(tmpDir, '.extraction-session-cursor'), '1700000000000\n', 'utf-8');
    const result = await readSessionCursor(tmpDir);
    expect(result).toEqual({});
    expect(log).toHaveBeenCalledWith('info', 'session-cursor:legacy-migration', expect.any(Object));
  });

  it('returns empty map when file contains corrupt JSON', async () => {
    await writeFile(join(tmpDir, '.extraction-session-cursor'), '{bad json\n', 'utf-8');
    const result = await readSessionCursor(tmpDir);
    expect(result).toEqual({});
    expect(log).toHaveBeenCalledWith('warn', 'session-cursor:corrupt-json', expect.any(Object));
  });

  it('returns empty map when file contains a JSON array', async () => {
    await writeFile(join(tmpDir, '.extraction-session-cursor'), '[1,2,3]\n', 'utf-8');
    const result = await readSessionCursor(tmpDir);
    expect(result).toEqual({});
    expect(log).toHaveBeenCalledWith('warn', 'session-cursor:corrupt', expect.any(Object));
  });
});

describe('getUnprocessedSessions tests', () => {
  let sessionDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sessionDir = join(tmpdir(), `sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('returns all session files when cursor is empty', async () => {
    await writeFile(join(sessionDir, 'session-001.md'), 'content', 'utf-8');
    await writeFile(join(sessionDir, 'session-002.txt'), 'content', 'utf-8');

    const result = await getUnprocessedSessions(sessionDir, {});
    expect(result.sort()).toEqual(['session-001.md', 'session-002.txt']);
  });

  it('excludes already-processed sessions with unchanged mtime', async () => {
    await writeFile(join(sessionDir, 'session-001.md'), 'content', 'utf-8');
    const fileStat = await stat(join(sessionDir, 'session-001.md'));

    const cursor = {
      'session-001.md': { offset: 7, mtimeMs: fileStat.mtimeMs },
    };

    const result = await getUnprocessedSessions(sessionDir, cursor);
    expect(result).toEqual([]);
  });

  it('includes sessions with changed mtime', async () => {
    await writeFile(join(sessionDir, 'session-001.md'), 'content', 'utf-8');
    // Set mtime to a known past value
    const pastTime = 1700000000;
    await utimes(join(sessionDir, 'session-001.md'), pastTime, pastTime);

    const cursor = {
      'session-001.md': { offset: 7, mtimeMs: 1600000000000 }, // different mtime
    };

    const result = await getUnprocessedSessions(sessionDir, cursor);
    expect(result).toEqual(['session-001.md']);
  });

  it('ignores non-session file extensions', async () => {
    await writeFile(join(sessionDir, 'data.json'), 'content', 'utf-8');
    await writeFile(join(sessionDir, 'notes.csv'), 'content', 'utf-8');

    const result = await getUnprocessedSessions(sessionDir, {});
    expect(result).toEqual([]);
  });

  it('returns empty array when session directory does not exist', async () => {
    const result = await getUnprocessedSessions('/nonexistent/path', {});
    expect(result).toEqual([]);
  });

  it('includes .jsonl files as session files', async () => {
    await writeFile(join(sessionDir, 'log.jsonl'), 'content', 'utf-8');

    const result = await getUnprocessedSessions(sessionDir, {});
    expect(result).toEqual(['log.jsonl']);
  });
});
