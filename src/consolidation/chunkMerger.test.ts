import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mergeChunkResults } from './chunkMerger.js';
import type { ChunkResult } from './chunkMerger.js';
import type { FileOperation } from '../types.js';

// --- Helpers ---

const OP_TYPES = ['create', 'update', 'delete'] as const;

/**
 * Arbitrary for a single FileOperation with a path drawn from a given pool.
 */
function fileOperationArb(pathPool: string[]): fc.Arbitrary<FileOperation> {
  return fc.record({
    op: fc.constantFrom(...OP_TYPES),
    path: fc.constantFrom(...pathPool),
    content: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
  });
}

/**
 * Arbitrary for a ChunkResult with a given chunkIndex and operations
 * drawn from a shared path pool.
 */
function chunkResultArb(
  chunkIndex: number,
  pathPool: string[],
): fc.Arbitrary<ChunkResult> {
  return fc
    .array(fileOperationArb(pathPool), { minLength: 0, maxLength: 10 })
    .map((operations) => ({ chunkIndex, operations }));
}

/**
 * Arbitrary that generates a list of ChunkResult objects with unique
 * ascending chunk indices and operations drawn from a shared path pool.
 */
const chunkResultsArb: fc.Arbitrary<ChunkResult[]> = fc
  .integer({ min: 1, max: 8 })
  .chain((pathCount) => {
    // Generate a pool of unique paths
    const pathPool = Array.from({ length: pathCount }, (_, i) => `memory/file-${i}.md`);
    return fc
      .integer({ min: 0, max: 5 })
      .chain((chunkCount) => {
        const chunkArbs = Array.from({ length: chunkCount }, (_, i) =>
          chunkResultArb(i, pathPool),
        );
        return chunkArbs.length === 0
          ? fc.constant([] as ChunkResult[])
          : fc.tuple(...(chunkArbs as [fc.Arbitrary<ChunkResult>, ...fc.Arbitrary<ChunkResult>[]]));
      })
      .map((result) => (Array.isArray(result) && !Array.isArray(result[0]?.operations) ? [] : result as ChunkResult[]));
  });

// --- Tests ---

// Feature: batch-consolidation, Property 5: Merge correctness
describe('Property 5: Merge correctness — last-chunk-wins with order preservation', () => {
  /**
   * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
   *
   * (a) For each file path appearing in multiple chunks, only the operation
   *     from the highest chunk index is present in the output.
   * (b) Non-conflicting operations appear in chunk-order then intra-chunk-order.
   * (c) Every unique file path from the input appears exactly once in the output.
   */
  it('last-chunk-wins for conflicting paths (Req 4.2, 4.3, 4.4)', () => {
    fc.assert(
      fc.property(chunkResultsArb, (chunkResults) => {
        const merged = mergeChunkResults(chunkResults);

        // Build a map of the expected winner for each path: last chunk index wins
        const expectedWinner = new Map<string, { chunkIndex: number; op: FileOperation }>();
        for (const chunk of chunkResults) {
          for (const op of chunk.operations) {
            const existing = expectedWinner.get(op.path);
            if (!existing || chunk.chunkIndex >= existing.chunkIndex) {
              expectedWinner.set(op.path, { chunkIndex: chunk.chunkIndex, op });
            }
          }
        }

        // (a) For each path in merged output, the operation must match the
        //     last-chunk-wins winner
        const mergedByPath = new Map<string, FileOperation>();
        for (const op of merged) {
          mergedByPath.set(op.path, op);
        }

        for (const [path, winner] of expectedWinner) {
          const mergedOp = mergedByPath.get(path);
          expect(mergedOp).toBeDefined();
          expect(mergedOp!.op).toBe(winner.op.op);
          expect(mergedOp!.path).toBe(path);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('every unique input path appears exactly once in output (Req 4.1, 4.5)', () => {
    fc.assert(
      fc.property(chunkResultsArb, (chunkResults) => {
        const merged = mergeChunkResults(chunkResults);

        // Collect all unique paths from input
        const inputPaths = new Set<string>();
        for (const chunk of chunkResults) {
          for (const op of chunk.operations) {
            inputPaths.add(op.path);
          }
        }

        // (c) Every unique input path appears exactly once in output
        const outputPaths = merged.map((op) => op.path);
        expect(new Set(outputPaths).size).toBe(outputPaths.length); // no duplicates
        expect(outputPaths.length).toBe(inputPaths.size); // completeness

        // Every input path is present
        for (const path of inputPaths) {
          expect(outputPaths).toContain(path);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('non-conflicting operations preserve chunk-order then intra-chunk-order (Req 4.5)', () => {
    fc.assert(
      fc.property(chunkResultsArb, (chunkResults) => {
        const merged = mergeChunkResults(chunkResults);

        // (b) For any two operations in the merged output that come from
        //     different winning chunks, the one from the lower chunk index
        //     must appear first. For operations from the same winning chunk,
        //     their relative order must match the original intra-chunk order.

        // Build winner info: for each path, which chunk won and what was
        // the intra-chunk position of the first occurrence in that chunk
        const sorted = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);
        const winnerChunk = new Map<string, number>();
        for (const chunk of sorted) {
          for (const op of chunk.operations) {
            const existing = winnerChunk.get(op.path);
            if (existing === undefined || chunk.chunkIndex >= existing) {
              winnerChunk.set(op.path, chunk.chunkIndex);
            }
          }
        }

        // Check pairwise ordering in merged output
        for (let i = 0; i < merged.length; i++) {
          for (let j = i + 1; j < merged.length; j++) {
            const chunkI = winnerChunk.get(merged[i].path)!;
            const chunkJ = winnerChunk.get(merged[j].path)!;

            // If both come from different chunks, lower chunk index first
            if (chunkI !== chunkJ) {
              expect(chunkI).toBeLessThan(chunkJ);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// --- Unit Tests for specific merge scenarios ---

describe('Unit tests: specific merge scenarios', () => {
  /**
   * **Validates: Requirements 4.3**
   * When chunk 0 creates a file and chunk 1 deletes the same file,
   * the merged result should resolve to a single delete operation.
   */
  it('create-then-delete resolves to delete (Req 4.3)', () => {
    const chunks: ChunkResult[] = [
      {
        chunkIndex: 0,
        operations: [{ op: 'create', path: 'memory/notes.md', content: '# Notes' }],
      },
      {
        chunkIndex: 1,
        operations: [{ op: 'delete', path: 'memory/notes.md' }],
      },
    ];

    const merged = mergeChunkResults(chunks);

    expect(merged).toHaveLength(1);
    expect(merged[0].op).toBe('delete');
    expect(merged[0].path).toBe('memory/notes.md');
  });

  /**
   * **Validates: Requirements 4.4**
   * When chunk 0 deletes a file and chunk 1 creates the same file,
   * the merged result should resolve to a single create operation.
   */
  it('delete-then-create resolves to create (Req 4.4)', () => {
    const chunks: ChunkResult[] = [
      {
        chunkIndex: 0,
        operations: [{ op: 'delete', path: 'memory/notes.md' }],
      },
      {
        chunkIndex: 1,
        operations: [{ op: 'create', path: 'memory/notes.md', content: '# New Notes' }],
      },
    ];

    const merged = mergeChunkResults(chunks);

    expect(merged).toHaveLength(1);
    expect(merged[0].op).toBe('create');
    expect(merged[0].path).toBe('memory/notes.md');
    expect(merged[0].content).toBe('# New Notes');
  });

  /**
   * **Validates: Requirements 5.3**
   * Passing an empty array to mergeChunkResults returns an empty array.
   */
  it('empty merge produces empty list (Req 5.3)', () => {
    const merged = mergeChunkResults([]);

    expect(merged).toEqual([]);
  });
});
