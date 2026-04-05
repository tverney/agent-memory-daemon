import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  planChunks,
  estimateFilePromptSize,
  PROMPT_TEMPLATE_OVERHEAD,
  PER_FILE_FORMATTING_OVERHEAD,
} from './chunkPlanner.js';
import type { MemoryFileWithSize } from './chunkPlanner.js';
import type { MemoryHeader } from '../types.js';

// --- Helpers ---

function makeMemory(
  name: string,
  contentSize: number,
  pathOverride?: string,
): MemoryFileWithSize {
  const header: MemoryHeader = {
    path: pathOverride ?? `${name}.md`,
    name,
    description: `Description of ${name}`,
    type: 'project',
    mtimeMs: Date.now(),
  };
  return { header, contentSize };
}

// --- Tests ---

describe('planChunks', () => {
  describe('zero memory files', () => {
    it('returns a single empty chunk', () => {
      const result = planChunks([], 0, 0, 60_000, 30);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].index).toBe(0);
      expect(result.chunks[0].memoryFiles).toEqual([]);
    });
  });

  describe('single chunk when all content fits', () => {
    it('returns one chunk with all files when under both limits', () => {
      const memories = [
        makeMemory('a', 100),
        makeMemory('b', 200),
        makeMemory('c', 150),
      ];
      const result = planChunks(memories, 500, 300, 60_000, 30);

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].index).toBe(0);
      expect(result.chunks[0].memoryFiles).toHaveLength(3);
      expect(result.chunks[0].memoryFiles.map((f) => f.name)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  describe('splitting by maxPromptChars', () => {
    it('splits into multiple chunks when content exceeds budget', () => {
      // Fixed overhead = PROMPT_TEMPLATE_OVERHEAD + session + manifest
      // With maxPromptChars = 10000, session = 0, manifest = 0:
      // available = 10000 - 3500 = 6500
      // Each file with contentSize=3000, path ~6 chars → ~3056 per file
      // So 2 files ≈ 6112 fits, 3 files ≈ 9168 doesn't
      const memories = [
        makeMemory('a', 3000),
        makeMemory('b', 3000),
        makeMemory('c', 3000),
      ];
      const result = planChunks(memories, 0, 0, 10_000, 30);

      expect(result.chunks.length).toBeGreaterThan(1);
      // All files should be assigned
      const allFiles = result.chunks.flatMap((c) => c.memoryFiles);
      expect(allFiles).toHaveLength(3);
    });
  });

  describe('splitting by maxFilesPerBatch', () => {
    it('splits when file count exceeds maxFilesPerBatch', () => {
      const memories = Array.from({ length: 5 }, (_, i) =>
        makeMemory(`file${i}`, 10),
      );
      const result = planChunks(memories, 0, 0, 60_000, 2);

      expect(result.chunks.length).toBe(3); // 2 + 2 + 1
      expect(result.chunks[0].memoryFiles).toHaveLength(2);
      expect(result.chunks[1].memoryFiles).toHaveLength(2);
      expect(result.chunks[2].memoryFiles).toHaveLength(1);
    });
  });

  describe('oversized single file', () => {
    it('places an oversized file alone in its own chunk', () => {
      // available budget = 10000 - 3500 = 6500
      // File with contentSize=50000 far exceeds budget
      const memories = [
        makeMemory('small', 100),
        makeMemory('huge', 50_000),
        makeMemory('another-small', 100),
      ];
      const result = planChunks(memories, 0, 0, 10_000, 30);

      // The huge file should be in its own chunk
      const hugeChunk = result.chunks.find((c) =>
        c.memoryFiles.some((f) => f.name === 'huge'),
      );
      expect(hugeChunk).toBeDefined();
      expect(hugeChunk!.memoryFiles).toHaveLength(1);

      // All files should still be present
      const allFiles = result.chunks.flatMap((c) => c.memoryFiles);
      expect(allFiles).toHaveLength(3);
    });
  });

  describe('chunk indices', () => {
    it('assigns 0-based sequential indices to chunks', () => {
      const memories = Array.from({ length: 6 }, (_, i) =>
        makeMemory(`f${i}`, 10),
      );
      const result = planChunks(memories, 0, 0, 60_000, 2);

      result.chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });
  });

  describe('session and manifest overhead', () => {
    it('accounts for session and manifest size in budget', () => {
      // maxPromptChars = 10000
      // sessionContentSize = 3000, manifestSize = 2000
      // fixedOverhead = 3500 + 3000 + 2000 = 8500
      // available = 10000 - 8500 = 1500
      // Each file ~110 chars → fits ~13 files in budget
      // But with contentSize=1000 per file → ~1056 per file, only 1 fits
      const memories = [
        makeMemory('a', 1000),
        makeMemory('b', 1000),
      ];
      const result = planChunks(memories, 3000, 2000, 10_000, 30);

      expect(result.chunks.length).toBe(2);
      expect(result.chunks[0].memoryFiles).toHaveLength(1);
      expect(result.chunks[1].memoryFiles).toHaveLength(1);
    });
  });

  describe('partition completeness', () => {
    it('every input file appears exactly once across all chunks', () => {
      const memories = Array.from({ length: 10 }, (_, i) =>
        makeMemory(`file-${i}`, 500),
      );
      const result = planChunks(memories, 0, 0, 10_000, 3);

      const allPaths = result.chunks.flatMap((c) =>
        c.memoryFiles.map((f) => f.path),
      );
      const inputPaths = memories.map((m) => m.header.path);

      // Same set, no duplicates
      expect(allPaths.sort()).toEqual(inputPaths.sort());
      expect(new Set(allPaths).size).toBe(allPaths.length);
    });
  });
});

describe('estimateFilePromptSize', () => {
  it('returns content size plus formatting overhead plus path length', () => {
    const mem = makeMemory('test', 1000, 'test-file.md');
    const estimate = estimateFilePromptSize(mem);
    expect(estimate).toBe(1000 + PER_FILE_FORMATTING_OVERHEAD + 'test-file.md'.length);
  });
});

// Feature: batch-consolidation, Property 1: Chunk size constraints
describe('Property 1: Chunk size constraints', () => {
  /**
   * Generator for a MemoryFileWithSize with random content size and a short path.
   */
  const memoryFileArb = fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 10 }),
      contentSize: fc.integer({ min: 0, max: 20_000 }),
    })
    .map(({ name, contentSize }) => {
      const header: MemoryHeader = {
        path: `${name}.md`,
        name,
        description: '',
        type: null,
        mtimeMs: 0,
      };
      return { header, contentSize } as MemoryFileWithSize;
    });

  /**
   * **Validates: Requirements 1.1, 1.2**
   *
   * For any set of memory files (0–100), any valid maxPromptChars (10000–100000),
   * and any valid maxFilesPerBatch (1–50), every chunk produced by planChunks
   * should have at most maxFilesPerBatch files, and every chunk's estimated
   * prompt size should not exceed maxPromptChars — unless the chunk contains
   * exactly one oversized file (the truncation case).
   */
  it('every chunk respects maxFilesPerBatch and maxPromptChars limits', () => {
    fc.assert(
      fc.property(
        fc.array(memoryFileArb, { minLength: 0, maxLength: 100 }),
        fc.integer({ min: 10_000, max: 100_000 }),
        fc.integer({ min: 1, max: 50 }),
        (memories, maxPromptChars, maxFilesPerBatch) => {
          const sessionContentSize = 0;
          const manifestSize = 0;
          const plan = planChunks(
            memories,
            sessionContentSize,
            manifestSize,
            maxPromptChars,
            maxFilesPerBatch,
          );

          const fixedOverhead =
            PROMPT_TEMPLATE_OVERHEAD + sessionContentSize + manifestSize;

          for (const chunk of plan.chunks) {
            // Requirement 1.2: no chunk exceeds maxFilesPerBatch
            expect(chunk.memoryFiles.length).toBeLessThanOrEqual(maxFilesPerBatch);

            // Requirement 1.1: estimated prompt size ≤ maxPromptChars,
            // UNLESS the chunk has exactly one file that is itself oversized
            // (the truncation case from Requirement 1.6).
            const chunkFileSize = chunk.memoryFiles.reduce((sum, header) => {
              // Reconstruct the MemoryFileWithSize to compute estimateFilePromptSize
              const original = memories.find(
                (m) => m.header.path === header.path,
              );
              if (!original) return sum;
              return sum + estimateFilePromptSize(original);
            }, 0);

            const estimatedPromptSize = fixedOverhead + chunkFileSize;

            if (chunk.memoryFiles.length === 1) {
              // Single-file chunk: allowed to exceed if the file itself is oversized
              // (no assertion on prompt size — this is the truncation case)
            } else {
              // Multi-file chunk: must respect maxPromptChars
              expect(estimatedPromptSize).toBeLessThanOrEqual(maxPromptChars);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: batch-consolidation, Property 3: Single chunk when content fits
describe('Property 3: Single chunk when content fits', () => {
  /**
   * **Validates: Requirements 1.3, 6.1, 6.2**
   *
   * For any set of memory files where the total estimated prompt size is
   * ≤ maxPromptChars and the file count is ≤ maxFilesPerBatch, planChunks
   * should produce exactly one chunk containing all files.
   */
  it('produces exactly one chunk containing all files when content fits within both limits', () => {
    fc.assert(
      fc.property(
        // Generate maxFilesPerBatch (1–50) first, then constrain file count
        fc.integer({ min: 1, max: 50 }).chain((maxFilesPerBatch) =>
          fc
            .array(
              fc
                .record({
                  name: fc.string({ minLength: 1, maxLength: 10 }),
                  contentSize: fc.integer({ min: 0, max: 500 }),
                })
                .map(({ name, contentSize }) => {
                  const header: MemoryHeader = {
                    path: `${name}.md`,
                    name,
                    description: '',
                    type: null,
                    mtimeMs: 0,
                  };
                  return { header, contentSize } as MemoryFileWithSize;
                }),
              { minLength: 0, maxLength: maxFilesPerBatch },
            )
            .map((memories) => ({ memories, maxFilesPerBatch })),
        ),
        fc.integer({ min: 0, max: 2000 }), // sessionContentSize
        fc.integer({ min: 0, max: 2000 }), // manifestSize
        ({ memories, maxFilesPerBatch }, sessionContentSize, manifestSize) => {
          // Compute the total estimated prompt size to ensure it fits
          const fixedOverhead =
            PROMPT_TEMPLATE_OVERHEAD + sessionContentSize + manifestSize;
          const totalFileSize = memories.reduce(
            (sum, m) => sum + estimateFilePromptSize(m),
            0,
          );
          const totalEstimatedSize = fixedOverhead + totalFileSize;

          // Set maxPromptChars high enough to guarantee everything fits
          const maxPromptChars = Math.max(10_000, totalEstimatedSize);

          const plan = planChunks(
            memories,
            sessionContentSize,
            manifestSize,
            maxPromptChars,
            maxFilesPerBatch,
          );

          // Exactly one chunk
          expect(plan.chunks).toHaveLength(1);
          expect(plan.chunks[0].index).toBe(0);

          // That chunk contains all input files
          const chunkPaths = plan.chunks[0].memoryFiles.map((f) => f.path);
          const inputPaths = memories.map((m) => m.header.path);
          expect(chunkPaths).toEqual(inputPaths);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: batch-consolidation, Property 2: Partition completeness
describe('Property 2: Partition completeness', () => {
  /**
   * Generator for a MemoryFileWithSize with random content size and a short path.
   */
  const memoryFileArb = fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 10 }),
      contentSize: fc.integer({ min: 0, max: 20_000 }),
    })
    .map(({ name, contentSize }) => {
      const header: MemoryHeader = {
        path: `${name}.md`,
        name,
        description: '',
        type: null,
        mtimeMs: 0,
      };
      return { header, contentSize } as MemoryFileWithSize;
    });

  /**
   * **Validates: Requirements 1.5**
   *
   * For any set of memory files (0–100), any valid maxPromptChars (10000–100000),
   * and any valid maxFilesPerBatch (1–50), the union of all chunk memory file
   * paths should equal the input set of paths (completeness), and no path should
   * appear in more than one chunk (no duplicates).
   */
  it('union of all chunk memory files equals input set with no duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(memoryFileArb, { minLength: 0, maxLength: 100 }),
        fc.integer({ min: 10_000, max: 100_000 }),
        fc.integer({ min: 1, max: 50 }),
        (memories, maxPromptChars, maxFilesPerBatch) => {
          const sessionContentSize = 0;
          const manifestSize = 0;
          const plan = planChunks(
            memories,
            sessionContentSize,
            manifestSize,
            maxPromptChars,
            maxFilesPerBatch,
          );

          // Collect all paths from all chunks
          const allChunkPaths = plan.chunks.flatMap((c) =>
            c.memoryFiles.map((f) => f.path),
          );

          // Input paths
          const inputPaths = memories.map((m) => m.header.path);

          // Completeness: same set of paths (sorted for comparison)
          expect(allChunkPaths.sort()).toEqual(inputPaths.sort());

          // No duplicates: the number of unique paths equals the total count
          expect(new Set(allChunkPaths).size).toBe(allChunkPaths.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
