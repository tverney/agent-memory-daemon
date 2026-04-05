import type { MemoryHeader } from '../types.js';

// --- Interfaces ---

export interface ChunkPlan {
  chunks: Chunk[];
}

export interface Chunk {
  index: number;              // 0-based chunk index
  memoryFiles: MemoryHeader[]; // memory files assigned to this chunk
}

export interface MemoryFileWithSize {
  header: MemoryHeader;
  contentSize: number;  // character count of the file's content
}

/**
 * Estimated character overhead for the prompt template (preamble, instructions,
 * response format, section headers) — everything that appears in every prompt
 * regardless of content. Derived from the existing promptBuilder output.
 */
export const PROMPT_TEMPLATE_OVERHEAD = 3500;

/**
 * Per-file formatting overhead in the prompt: the markdown wrapper around each
 * memory file's content (### header, code fence, newlines).
 * Pattern: `### {path}\n\n\`\`\`markdown\n{content}\n\`\`\``
 * ~22 chars of fixed wrapping + path length. We use a conservative estimate.
 */
export const PER_FILE_FORMATTING_OVERHEAD = 50;

/**
 * Estimate the prompt contribution of a single memory file.
 * This accounts for the file's content plus the markdown formatting overhead.
 */
export function estimateFilePromptSize(file: MemoryFileWithSize): number {
  return file.contentSize + PER_FILE_FORMATTING_OVERHEAD + file.header.path.length;
}

/**
 * Partition memory files into chunks respecting both `maxPromptChars` and
 * `maxFilesPerBatch` limits.
 *
 * Algorithm:
 * 1. Compute fixed overhead: prompt template + session content + manifest
 * 2. For each memory file, estimate its prompt contribution (content + formatting)
 * 3. Greedily assign files to chunks, starting a new chunk when either:
 *    - Adding the next file would exceed maxPromptChars (accounting for overhead)
 *    - The chunk already has maxFilesPerBatch files
 * 4. If a single file exceeds the available budget, place it alone and truncate
 * 5. If total content fits in one chunk, return a single chunk
 *
 * @param memories - All memory file headers with content sizes
 * @param sessionContentSize - Total character count of all session content (included in every chunk)
 * @param manifestSize - Character count of the full memory manifest (included in every chunk)
 * @param maxPromptChars - Maximum prompt size per chunk
 * @param maxFilesPerBatch - Maximum memory files per chunk
 */
export function planChunks(
  memories: MemoryFileWithSize[],
  sessionContentSize: number,
  manifestSize: number,
  maxPromptChars: number,
  maxFilesPerBatch: number,
): ChunkPlan {
  // Zero memory files → single empty chunk
  if (memories.length === 0) {
    return { chunks: [{ index: 0, memoryFiles: [] }] };
  }

  // Fixed overhead present in every chunk: template + sessions + manifest
  const fixedOverhead = PROMPT_TEMPLATE_OVERHEAD + sessionContentSize + manifestSize;

  // Available budget for memory file content per chunk
  const availableBudget = maxPromptChars - fixedOverhead;

  const chunks: Chunk[] = [];
  let currentFiles: MemoryHeader[] = [];
  let currentSize = 0;

  for (const memory of memories) {
    const fileSize = estimateFilePromptSize(memory);

    // Check if adding this file would exceed either limit
    const wouldExceedChars = currentSize + fileSize > availableBudget;
    const wouldExceedFiles = currentFiles.length >= maxFilesPerBatch;

    if (currentFiles.length > 0 && (wouldExceedChars || wouldExceedFiles)) {
      // Finalize current chunk and start a new one
      chunks.push({ index: chunks.length, memoryFiles: currentFiles });
      currentFiles = [];
      currentSize = 0;
    }

    // Place the file — even if it's oversized, it goes alone in its chunk
    currentFiles.push(memory.header);
    currentSize += fileSize;
  }

  // Finalize the last chunk
  if (currentFiles.length > 0) {
    chunks.push({ index: chunks.length, memoryFiles: currentFiles });
  }

  return { chunks };
}
