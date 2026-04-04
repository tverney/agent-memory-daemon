import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readExtractionCursor, writeExtractionCursor } from './cursorManager.js';
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
