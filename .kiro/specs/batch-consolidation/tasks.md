# Implementation Plan: Batch Consolidation

## Overview

Add chunk-based processing to the consolidation engine so large memory sets are split into smaller LLM prompts. Implements ChunkPlanner, ChunkMerger, chunk-aware prompt building, and engine orchestration. Preserves single-pass behavior when content fits in one chunk.

## Tasks

- [x] 1. Extend config and types for batch consolidation
  - [x] 1.1 Add `maxPromptChars` and `maxFilesPerBatch` to `MemconsolidateConfig` in `src/types.ts`
    - Add `maxPromptChars: number` and `maxFilesPerBatch: number` fields
    - Add `chunksTotal: number` and `chunksCompleted: number` to `ConsolidationResult`
    - _Requirements: 2.1, 2.2, 7.1, 7.2_

  - [x] 1.2 Extend `src/config.ts` with defaults, validation, and TOML key mapping
    - Add `max_prompt_chars` → `maxPromptChars` and `max_files_per_batch` → `maxFilesPerBatch` to `KEY_MAP`
    - Add defaults: `maxPromptChars: 60_000`, `maxFilesPerBatch: 30`
    - Add validation: `maxPromptChars >= 10_000` with descriptive error, `maxFilesPerBatch >= 1` with descriptive error
    - Wire defaults and validation into `validateConfig`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 1.3 Write property test for config validation (Property 4)
    - **Property 4: Invalid batch config rejected**
    - Generate random numbers < 10000 for `maxPromptChars` and < 1 for `maxFilesPerBatch`, verify `validateConfig` throws
    - **Validates: Requirements 2.3, 2.4**

  - [x] 1.4 Write unit tests for config defaults and TOML key mapping
    - Verify `maxPromptChars` defaults to 60000 and `maxFilesPerBatch` defaults to 30
    - Verify `max_prompt_chars` and `max_files_per_batch` TOML keys map correctly
    - _Requirements: 2.1, 2.2, 2.5_

- [-] 2. Implement ChunkPlanner
  - [x] 2.1 Create `src/consolidation/chunkPlanner.ts` with `planChunks` function
    - Define `ChunkPlan`, `Chunk`, and `MemoryFileWithSize` interfaces
    - Implement greedy partitioning: compute fixed overhead (template + sessions + manifest), assign files to chunks respecting `maxPromptChars` and `maxFilesPerBatch`
    - Handle oversized single files by placing them alone in a chunk with truncation
    - Return single chunk when all content fits
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 2.2 Write property test for chunk size constraints (Property 1)
    - **Property 1: Chunk size constraints**
    - Generate random `MemoryFileWithSize` arrays (0–100 files, sizes 0–20000), random `maxPromptChars` (10000–100000), random `maxFilesPerBatch` (1–50). Verify every chunk respects both limits.
    - **Validates: Requirements 1.1, 1.2**

  - [x] 2.3 Write property test for partition completeness (Property 2)
    - **Property 2: Partition completeness**
    - Same generators as Property 1. Verify union of all chunk memory files equals input set, no duplicates.
    - **Validates: Requirements 1.5**

  - [x] 2.4 Write property test for single chunk when content fits (Property 3)
    - **Property 3: Single chunk when content fits**
    - Generate file sets that fit within both limits. Verify exactly one chunk containing all files.
    - **Validates: Requirements 1.3, 6.1, 6.2**

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement ChunkMerger
  - [x] 4.1 Create `src/consolidation/chunkMerger.ts` with `mergeChunkResults` function
    - Define `ChunkResult` interface
    - Implement last-chunk-wins merge: for each file path in multiple chunks, keep only the operation from the highest chunk index
    - Preserve relative order of non-conflicting operations (chunk order, then intra-chunk order)
    - Ensure every unique file path from input appears exactly once in output
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 4.2 Write property test for merge correctness (Property 5)
    - **Property 5: Merge correctness — last-chunk-wins with order preservation**
    - Generate random `ChunkResult` arrays with overlapping and non-overlapping paths. Verify last-chunk-wins, order preservation, and completeness.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**

  - [x] 4.3 Write unit tests for specific merge scenarios
    - Test create-then-delete resolves to delete (Req 4.3)
    - Test delete-then-create resolves to create (Req 4.4)
    - Test empty merge produces empty list
    - _Requirements: 4.3, 4.4, 5.3_

- [x] 5. Add chunk-aware prompt building
  - [x] 5.1 Add `buildChunkPrompt` function to `src/consolidation/promptBuilder.ts`
    - Include full memory manifest (all files) and full MEMORY.md index in every chunk prompt
    - Include only the memory file contents assigned to the current chunk
    - Include all session file contents (truncated per `maxSessionContentChars`)
    - Add chunk context header: "Processing chunk X of Y. This chunk contains: [file list]"
    - Keep existing `buildConsolidationPrompt` unchanged for single-chunk passes
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 5.2 Write property test for chunk prompt shared context (Property 6)
    - **Property 6: Chunk prompt contains full shared context**
    - Generate random memory headers, index entries, and session content. Verify each chunk prompt contains full manifest, full index, and all sessions.
    - **Validates: Requirements 8.1, 8.2, 8.4, 1.4**

  - [x] 5.3 Write property test for chunk prompt content isolation (Property 7)
    - **Property 7: Chunk prompt content isolation**
    - Generate multi-chunk plans with distinct file contents. Verify each chunk prompt contains only its assigned files' content.
    - **Validates: Requirements 8.3**

  - [x] 5.4 Write property test for chunk prompt context header (Property 8)
    - **Property 8: Chunk prompt context header**
    - Generate random chunk configurations. Verify the prompt contains chunk index, total, and file names.
    - **Validates: Requirements 8.5**

- [x] 6. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Modify consolidation engine for chunk-aware flow
  - [x] 7.1 Update `runConsolidation` in `src/consolidation/consolidationEngine.ts`
    - Scan memory files and compute content sizes
    - Call `planChunks()` to get the chunk plan
    - If single chunk: use existing single-pass behavior (call `buildConsolidationPrompt`, one LLM call)
    - If multiple chunks: loop sequentially, check abort signal before each chunk, call `buildChunkPrompt`, call `retryLlmCall`, collect operations per chunk
    - Call `mergeChunkResults()` on collected operations for multi-chunk passes
    - Validate and apply merged operations using existing logic
    - Update MEMORY.md index once from merged operations
    - Set `chunksTotal` and `chunksCompleted` on result
    - Aggregate `promptLength` as sum of all chunk prompt lengths
    - Aggregate `operationsRequested` as sum across all chunks
    - Log chunk index, total, and prompt size before each LLM call
    - Log `chunksTotal` and `chunksCompleted` in consolidation-complete event
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 7.2 Write property test for result chunk metrics (Property 9)
    - **Property 9: Result chunk metrics**
    - Mock LLM backend, run consolidation with various file sets. Verify `chunksTotal` and `chunksCompleted` values.
    - **Validates: Requirements 7.1, 7.2**

  - [x] 7.3 Write property test for result aggregated metrics (Property 10)
    - **Property 10: Result aggregated metrics**
    - Mock LLM to return known operation counts. Verify `promptLength` and `operationsRequested` are sums.
    - **Validates: Requirements 7.3, 7.4**

  - [x] 7.4 Write unit tests for engine chunk orchestration
    - Test single-chunk backward compatibility: exactly one LLM call, `chunksTotal: 1, chunksCompleted: 1`
    - Test abort between chunks: mock LLM, abort after first chunk, verify partial results
    - Test LLM failure stops processing: mock LLM to fail on chunk 2, verify error propagation and `chunksCompleted: 1`
    - Test chunk logging: verify log events contain chunk index, total, and prompt size
    - _Requirements: 3.2, 3.4, 3.5, 6.1, 6.2, 6.3, 7.5_

- [x] 8. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All tests mock the `LlmBackend` interface — no real LLM calls
