# Requirements Document

## Introduction

The consolidation engine in agent-memory-daemon currently builds a single LLM prompt containing ALL memory files and ALL session files. When the memory set grows large (57+ memory files, 48+ sessions), the prompt can exceed 90K characters, causing Bedrock API timeouts (ECONNABORTED after 22 minutes). This feature adds batch/chunk processing to split large consolidation passes into smaller prompts that fit within LLM context limits, merging results across chunks, while preserving single-pass behavior when the content is small enough.

## Glossary

- **Consolidation_Engine**: The module (`consolidationEngine.ts`) that orchestrates a four-phase consolidation pass: orient, gather, consolidate, prune.
- **Prompt_Builder**: The module (`promptBuilder.ts`) that assembles the self-contained LLM prompt from memory files and session files.
- **Chunk**: A subset of memory files and session files grouped together to form a single LLM prompt that fits within the configured size limit.
- **Chunk_Planner**: The component responsible for partitioning memory files and session files into chunks.
- **Chunk_Merger**: The component responsible for reconciling file operations returned from multiple chunk LLM calls into a single consistent set of operations.
- **Batch_Config**: The set of configuration fields that control chunking behavior: `maxPromptChars` and `maxFilesPerBatch`.
- **Memory_File**: A markdown file in the memory directory with YAML frontmatter containing name, description, and type fields.
- **Session_File**: A file in the session directory containing conversation transcripts (plain text or JSONL).
- **MEMORY_Index**: The `MEMORY.md` file that serves as the index/entrypoint listing all memory files.
- **Prompt_Size**: The character length of the assembled LLM prompt string.
- **LLM_Backend**: The pluggable provider abstraction that sends prompts and returns file operations.

## Requirements

### Requirement 1: Chunk Planning

**User Story:** As a daemon operator, I want the consolidation engine to split large memory sets into smaller chunks, so that each LLM call stays within context limits and avoids API timeouts.

#### Acceptance Criteria

1. WHEN the total Prompt_Size for all Memory_Files and Session_Files exceeds `maxPromptChars`, THE Chunk_Planner SHALL partition the files into multiple Chunks where each Chunk produces a prompt no larger than `maxPromptChars`.
2. WHEN the total number of Memory_Files exceeds `maxFilesPerBatch`, THE Chunk_Planner SHALL partition the Memory_Files such that no single Chunk contains more than `maxFilesPerBatch` Memory_Files.
3. WHEN the total Prompt_Size is at or below `maxPromptChars` and the total number of Memory_Files is at or below `maxFilesPerBatch`, THE Chunk_Planner SHALL produce exactly one Chunk containing all files.
4. THE Chunk_Planner SHALL include all Session_Files in every Chunk so that the LLM has full session context for each batch.
5. THE Chunk_Planner SHALL assign every Memory_File to exactly one Chunk with no Memory_File omitted and no Memory_File duplicated across Chunks.
6. IF a single Memory_File's content exceeds `maxPromptChars` minus the fixed prompt overhead, THEN THE Chunk_Planner SHALL place that Memory_File in its own Chunk and truncate the file content to fit.

### Requirement 2: Batch Configuration

**User Story:** As a daemon operator, I want configurable limits for chunk sizing, so that I can tune the batching behavior for different LLM providers and context windows.

#### Acceptance Criteria

1. THE Batch_Config SHALL include a `maxPromptChars` field with a default value of 60000.
2. THE Batch_Config SHALL include a `maxFilesPerBatch` field with a default value of 30.
3. WHEN `maxPromptChars` is set to a value less than 10000, THE config validator SHALL reject the configuration with a descriptive error message.
4. WHEN `maxFilesPerBatch` is set to a value less than 1, THE config validator SHALL reject the configuration with a descriptive error message.
5. THE config loader SHALL map the TOML snake_case keys `max_prompt_chars` and `max_files_per_batch` to the camelCase fields `maxPromptChars` and `maxFilesPerBatch`.

### Requirement 3: Chunk Execution

**User Story:** As a daemon operator, I want each chunk to be processed as an independent LLM call, so that no single call exceeds context limits.

#### Acceptance Criteria

1. THE Consolidation_Engine SHALL process each Chunk sequentially, sending one LLM prompt per Chunk.
2. WHEN the AbortSignal is triggered between Chunk executions, THE Consolidation_Engine SHALL stop processing remaining Chunks and return partial results.
3. THE Consolidation_Engine SHALL use the existing `retryLlmCall` mechanism for each individual Chunk LLM call.
4. IF an LLM call for a Chunk fails after retries, THEN THE Consolidation_Engine SHALL stop processing remaining Chunks and propagate the error.
5. THE Consolidation_Engine SHALL log the Chunk index, total Chunk count, and prompt size before each LLM call.

### Requirement 4: Result Merging

**User Story:** As a daemon operator, I want file operations from multiple chunks to be merged into a consistent final set, so that the memory directory ends up in a correct state.

#### Acceptance Criteria

1. THE Chunk_Merger SHALL combine file operations from all completed Chunks into a single ordered list of operations.
2. WHEN multiple Chunks return operations targeting the same file path, THE Chunk_Merger SHALL keep only the operation from the latest Chunk (highest chunk index).
3. WHEN one Chunk creates a file and a later Chunk deletes the same file, THE Chunk_Merger SHALL resolve to a single delete operation.
4. WHEN one Chunk deletes a file and a later Chunk creates the same file, THE Chunk_Merger SHALL resolve to a single create operation.
5. THE Chunk_Merger SHALL preserve the relative order of non-conflicting operations from each Chunk.

### Requirement 5: Index Update

**User Story:** As a daemon operator, I want the MEMORY_Index to be updated exactly once after all chunks complete, so that the index reflects the final merged state.

#### Acceptance Criteria

1. THE Consolidation_Engine SHALL update the MEMORY_Index only after all Chunks have been processed and their results merged.
2. THE Consolidation_Engine SHALL build the updated index from the merged set of file operations, not from individual Chunk results.
3. WHEN zero file operations result from the merged set, THE Consolidation_Engine SHALL still update the MEMORY_Index to reflect the current state of the memory directory.

### Requirement 6: Single-Pass Preservation

**User Story:** As a daemon operator, I want small memory sets to continue running as a single consolidation pass with no behavioral change, so that the batching feature does not regress existing behavior.

#### Acceptance Criteria

1. WHEN the Chunk_Planner produces exactly one Chunk, THE Consolidation_Engine SHALL execute the consolidation identically to the pre-batching single-pass behavior.
2. WHEN the Chunk_Planner produces exactly one Chunk, THE Consolidation_Engine SHALL make exactly one LLM call.
3. THE ConsolidationResult returned for a single-Chunk pass SHALL have the same structure and field semantics as the pre-batching implementation.

### Requirement 7: Consolidation Result Reporting

**User Story:** As a daemon operator, I want the consolidation result to include batch-related metrics, so that I can monitor chunking behavior.

#### Acceptance Criteria

1. THE ConsolidationResult SHALL include a `chunksTotal` field indicating the total number of Chunks planned.
2. THE ConsolidationResult SHALL include a `chunksCompleted` field indicating the number of Chunks that completed LLM calls.
3. THE ConsolidationResult SHALL aggregate `operationsRequested`, `operationsApplied`, and `operationsSkipped` across all Chunks.
4. THE ConsolidationResult SHALL report the total `promptLength` as the sum of prompt lengths across all Chunks.
5. THE Consolidation_Engine SHALL log the `chunksTotal` and `chunksCompleted` fields in the consolidation-complete log event.

### Requirement 8: Chunk Prompt Content

**User Story:** As a daemon operator, I want each chunk prompt to contain enough context for the LLM to make informed decisions, so that chunk results are coherent.

#### Acceptance Criteria

1. THE Prompt_Builder SHALL include the full MEMORY_Index in every Chunk prompt so the LLM knows the complete memory landscape.
2. THE Prompt_Builder SHALL include the memory manifest (list of all Memory_File names and descriptions) in every Chunk prompt.
3. THE Prompt_Builder SHALL include only the Memory_File contents assigned to that Chunk.
4. THE Prompt_Builder SHALL include all Session_File contents in every Chunk prompt, each truncated to `maxSessionContentChars`.
5. THE Prompt_Builder SHALL include a Chunk context header stating the current Chunk index, total Chunk count, and which Memory_Files are included in this Chunk.
