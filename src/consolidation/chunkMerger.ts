import type { FileOperation } from '../types.js';

// --- Interfaces ---

export interface ChunkResult {
  chunkIndex: number;
  operations: FileOperation[];
}

/**
 * Merge operations from multiple chunks using last-chunk-wins semantics.
 *
 * For each file path that appears in multiple chunks, only the operation
 * from the highest chunk index is kept. Non-conflicting operations are
 * preserved in their original order (chunk order, then intra-chunk order).
 *
 * @param chunkResults - Operations from each chunk, ordered by chunk index
 * @returns Merged list of file operations with exactly one entry per unique path
 */
export function mergeChunkResults(chunkResults: ChunkResult[]): FileOperation[] {
  if (chunkResults.length === 0) {
    return [];
  }

  // Sort by chunk index ascending so later chunks overwrite earlier ones
  const sorted = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);

  // Track the winning operation for each path (last-chunk-wins)
  const winnerByPath = new Map<string, { chunkIndex: number; opIndex: number; operation: FileOperation }>();

  // First pass: determine the winner for each path.
  // Within the same chunk, later operations on the same path overwrite earlier ones.
  for (const chunk of sorted) {
    for (let i = 0; i < chunk.operations.length; i++) {
      const op = chunk.operations[i];
      const existing = winnerByPath.get(op.path);
      if (!existing || chunk.chunkIndex >= existing.chunkIndex) {
        winnerByPath.set(op.path, { chunkIndex: chunk.chunkIndex, opIndex: i, operation: op });
      }
    }
  }

  // Second pass: collect operations in chunk-order then intra-chunk-order,
  // emitting each path only at its first appearance in the winning chunk
  const emitted = new Set<string>();
  const result: FileOperation[] = [];

  for (const chunk of sorted) {
    for (const op of chunk.operations) {
      if (emitted.has(op.path)) {
        continue;
      }
      const winner = winnerByPath.get(op.path)!;
      if (winner.chunkIndex === chunk.chunkIndex) {
        result.push(winner.operation);
        emitted.add(op.path);
      }
    }
  }

  return result;
}
