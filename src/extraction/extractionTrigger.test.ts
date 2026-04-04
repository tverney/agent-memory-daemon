import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateExtractionTrigger } from './extractionTrigger.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

const SESSION_EXTENSIONS = ['.md', '.txt', '.jsonl'] as const;
const NON_SESSION_EXTENSIONS = ['.json', '.log', '.csv', '.xml', '.yaml'] as const;

/**
 * Arbitrary for a valid session filename with a session extension.
 */
const sessionFilenameArb = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/),
    fc.constantFrom(...SESSION_EXTENSIONS),
  )
  .map(([name, ext]) => `${name}${ext}`);

/**
 * Arbitrary for a non-session filename (should be excluded from results).
 */
const nonSessionFilenameArb = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/),
    fc.constantFrom(...NON_SESSION_EXTENSIONS),
  )
  .map(([name, ext]) => `${name}${ext}`);

/**
 * Arbitrary for a file entry with a filename and mtime in milliseconds.
 * Timestamps are in whole seconds (multiplied by 1000) to avoid sub-second
 * rounding issues with filesystem mtime resolution.
 */
const sessionFileEntryArb = fc
  .tuple(
    sessionFilenameArb,
    fc.integer({ min: 1_000_000, max: 2_000_000 }).map((s) => s * 1000),
  )
  .map(([filename, mtimeMs]) => ({ filename, mtimeMs }));

const nonSessionFileEntryArb = fc
  .tuple(
    nonSessionFilenameArb,
    fc.integer({ min: 1_000_000, max: 2_000_000 }).map((s) => s * 1000),
  )
  .map(([filename, mtimeMs]) => ({ filename, mtimeMs }));

describe('Extraction trigger property tests', () => {
  // Feature: memory-extraction, Property 4: Extraction trigger correctly partitions session files
  it('Property 4: Extraction trigger correctly partitions session files', async () => {
    // Validates: Requirements 2.1, 2.2, 2.3, 2.4

    // Generate a unique set of session files (deduplicated by filename),
    // optional non-session files, and a cursor timestamp in whole seconds.
    const inputArb = fc
      .tuple(
        fc.array(sessionFileEntryArb, { minLength: 0, maxLength: 10 }),
        fc.array(nonSessionFileEntryArb, { minLength: 0, maxLength: 5 }),
        fc.integer({ min: 1_000_000, max: 2_000_000 }).map((s) => s * 1000),
      )
      .map(([sessionFiles, nonSessionFiles, cursorTimestamp]) => {
        // Deduplicate by filename — keep first occurrence
        const seen = new Set<string>();
        const uniqueSession = sessionFiles.filter((f) => {
          if (seen.has(f.filename)) return false;
          seen.add(f.filename);
          return true;
        });
        const uniqueNonSession = nonSessionFiles.filter((f) => {
          if (seen.has(f.filename)) return false;
          seen.add(f.filename);
          return true;
        });
        return {
          sessionFiles: uniqueSession,
          nonSessionFiles: uniqueNonSession,
          cursorTimestamp,
        };
      });

    await fc.assert(
      fc.asyncProperty(inputArb, async ({ sessionFiles, nonSessionFiles, cursorTimestamp }) => {
        // Create a fresh temp directory for each iteration
        const tmpDir = join(
          tmpdir(),
          `trigger-pbt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        await mkdir(tmpDir, { recursive: true });

        try {
          // Create all files and set their mtimes
          const allFiles = [...sessionFiles, ...nonSessionFiles];
          for (const { filename, mtimeMs } of allFiles) {
            const filePath = join(tmpDir, filename);
            await writeFile(filePath, `content of ${filename}`, 'utf-8');
            const timeSec = mtimeMs / 1000;
            await utimes(filePath, timeSec, timeSec);
          }

          // Call the function under test
          const result = await evaluateExtractionTrigger(tmpDir, cursorTimestamp);

          // Compute expected modified session files (only session extensions, mtime > cursor)
          const expectedModified = sessionFiles
            .filter((f) => f.mtimeMs > cursorTimestamp)
            .map((f) => f.filename);

          // Verify: triggered is true iff at least one session file has mtime > cursor
          expect(result.triggered).toBe(expectedModified.length > 0);

          // Verify: modifiedFiles contains exactly the expected filenames
          expect(result.modifiedFiles.sort()).toEqual(expectedModified.sort());

          // Verify: modifiedFiles is empty when triggered is false
          if (!result.triggered) {
            expect(result.modifiedFiles).toEqual([]);
          }

          // Verify: non-session files are never included
          for (const nsf of nonSessionFiles) {
            expect(result.modifiedFiles).not.toContain(nsf.filename);
          }
        } finally {
          await rm(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
