# Implementation Plan: Memory Extraction

## Overview

Add a second operational mode (extraction) to the agent-memory-daemon. Implementation proceeds incrementally: shared types and config first, then new extraction modules (cursor, trigger, prompt builder, engine), then daemon integration, with property-based and unit tests woven in alongside each component.

## Tasks

- [x] 1. Extend shared types and configuration
  - [x] 1.1 Add extraction types to `src/types.ts`
    - Add `ExtractionResult` interface with fields: `filesCreated`, `filesUpdated`, `durationMs`, `promptLength`, `operationsRequested`, `operationsApplied`, `operationsSkipped`
    - Add `ExtractionTriggerResult` interface with fields: `triggered`, `modifiedFiles`
    - Extend `MemconsolidateConfig` with three new fields: `extractionEnabled` (boolean), `extractionIntervalMs` (number), `maxExtractionSessionChars` (number)
    - _Requirements: 1.1, 1.2, 1.3, 9.1_

  - [x] 1.2 Extend `src/config.ts` with extraction config support
    - Add `extraction_enabled`, `extraction_interval_ms`, `max_extraction_session_chars` to `KEY_MAP`
    - Add defaults: `extractionEnabled: false`, `extractionIntervalMs: 60_000`, `maxExtractionSessionChars: 5_000`
    - Add validation: `extractionIntervalMs >= 10_000` with descriptive error
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6_

  - [x] 1.3 Write property tests for extraction config (Properties 1–3)
    - **Property 1: Extraction config defaults are applied** — generate config objects omitting extraction fields, verify defaults
    - **Validates: Requirements 1.1, 1.2, 1.3**
    - **Property 2: Invalid extraction interval is rejected** — generate values < 10000, verify error thrown
    - **Validates: Requirements 1.4**
    - **Property 3: TOML snake_case keys map to camelCase** — generate configs with snake_case keys, verify camelCase output
    - **Validates: Requirements 1.6**

- [x] 2. Implement cursor manager (`src/extraction/cursorManager.ts`)
  - [x] 2.1 Create `src/extraction/cursorManager.ts`
    - Implement `readExtractionCursor(memoryDir)` — reads `.extraction-cursor` file, returns timestamp as number, returns 0 if file missing or corrupt
    - Implement `writeExtractionCursor(memoryDir, timestampMs)` — writes timestamp to `.extraction-cursor`
    - _Requirements: 2.5, 2.6, 8.1, 8.2, 8.3, 8.4_

  - [x] 2.2 Write property test for cursor round-trip (Property 5)
    - **Property 5: Cursor read/write round-trip** — generate non-negative integer timestamps, write then read, verify equality
    - **Validates: Requirements 2.5, 8.3, 8.4**

  - [x] 2.3 Write unit tests for cursor edge cases
    - Test that `readExtractionCursor` returns 0 when file does not exist
    - Test that `readExtractionCursor` returns 0 when file contains non-numeric content (with warning log)
    - _Requirements: 2.6_

- [x] 3. Implement extraction trigger (`src/extraction/extractionTrigger.ts`)
  - [x] 3.1 Create `src/extraction/extractionTrigger.ts`
    - Implement `evaluateExtractionTrigger(sessionDir, cursorTimestamp)` returning `ExtractionTriggerResult`
    - Scan session directory for `.md`, `.txt`, `.jsonl` files
    - Compare each file's mtime against cursor; collect files with mtime > cursor
    - Return `{ triggered: true, modifiedFiles }` if any found, else `{ triggered: false, modifiedFiles: [] }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Write property test for extraction trigger (Property 4)
    - **Property 4: Extraction trigger correctly partitions session files** — generate random sets of `{ filename, mtimeMs }` and a cursor timestamp, verify correct partitioning
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Export shared utilities from consolidation engine
  - [x] 5.1 Export helper functions from `src/consolidation/consolidationEngine.ts`
    - Export `retryLlmCall`, `validateOperationPath`, `validateFileContent`, `applyOperation`, `buildUpdatedIndex`
    - These are currently module-private; add `export` keyword to each function
    - Verify existing consolidation tests still pass after the change
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.2, 6.3, 6.4, 6.5_

- [x] 6. Implement extraction prompt builder (`src/extraction/extractionPromptBuilder.ts`)
  - [x] 6.1 Create `src/extraction/extractionPromptBuilder.ts`
    - Implement `buildExtractionPrompt(memoryDir, sessionFiles, sessionDir, maxSessionChars, maxMemoryChars)`
    - Include memory manifest (via `scanMemoryFiles` + `formatMemoryManifest`)
    - Include content of modified session files, truncated to `maxExtractionSessionChars`
    - Include today's date in ISO format
    - Include LLM instructions: identify facts, decisions, preferences, error corrections; check manifest before creating; classify with memory types; return JSON `{ operations, reasoning }`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 11.1, 11.4_

  - [x] 6.2 Write property test for extraction prompt content (Property 8)
    - **Property 8: Extraction prompt contains manifest, session content, and date** — generate memory headers and session content, verify prompt contains expected substrings
    - **Validates: Requirements 4.1, 4.2, 4.7**

  - [x] 6.3 Write unit tests for prompt instruction content
    - Verify prompt contains keywords: "facts", "decisions", "preferences", "user", "feedback", "project", "reference", "JSON"
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

- [x] 7. Implement extraction engine (`src/extraction/extractionEngine.ts`)
  - [x] 7.1 Create `src/extraction/extractionEngine.ts`
    - Implement `runExtraction(config, backend, modifiedSessionFiles, signal)` returning `ExtractionResult`
    - Build prompt via `buildExtractionPrompt`
    - Call LLM via `retryLlmCall` (imported from consolidation engine)
    - Validate operations via `validateOperationPath` and `validateFileContent`
    - Apply operations via `applyOperation` (skip writes if `dryRun`)
    - Update MEMORY.md index via `readIndex`, `buildUpdatedIndex`, `writeIndex`, `truncateIndexContent`
    - Skip index update if zero operations applied
    - Return populated `ExtractionResult`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 9.1, 11.2, 11.3_

  - [x] 7.2 Write property test for validation rejects unsafe paths (Property 9)
    - **Property 9: Validation rejects unsafe paths and invalid frontmatter** — generate paths with traversal, absolute, non-.md, MEMORY.md targets; verify rejection
    - **Validates: Requirements 6.2, 6.3**

  - [x] 7.3 Write property test for file operation round-trip (Property 10)
    - **Property 10: Valid file operations are applied to disk** — generate valid create/update operations, apply to temp dir, read back, verify content equality
    - **Validates: Requirements 6.4, 6.5**

  - [x] 7.4 Write property test for dry run (Property 11)
    - **Property 11: Dry run produces no file writes** — generate operations with dryRun=true, verify no files created/modified on disk
    - **Validates: Requirements 6.6**

  - [x] 7.5 Write property test for index update (Property 12)
    - **Property 12: Index updated if and only if operations were applied** — run extraction with/without operations, verify index state
    - **Validates: Requirements 7.1, 7.4**

  - [x] 7.6 Write property test for ExtractionResult fields (Property 17)
    - **Property 17: ExtractionResult contains all required fields** — run extraction, verify all fields are non-negative numbers and arrays
    - **Validates: Requirements 9.1**

- [x] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Integrate extraction into daemon (`src/daemon.ts`)
  - [x] 9.1 Extend `MemconsolidateDaemon` with extraction state and logic
    - Add instance fields: `extracting` (boolean), `lastExtractionAt` (number), `extractionPriorMtime` (number)
    - Extend `runOnce()`: after consolidation path, if `extractionEnabled` and consolidation didn't run, check extraction rate limit, evaluate extraction trigger, acquire lock, call `runExtraction`, release/rollback lock, advance cursor
    - Extend `start()`: perform initial extraction check alongside initial consolidation check
    - Extend `stop()`: abort in-progress extraction and rollback lock
    - Log events: `daemon:extraction-start`, `daemon:extraction-complete`, `daemon:extraction-failed`
    - _Requirements: 1.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.1, 8.2, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 9.2 Write property test for mutual exclusion (Property 6)
    - **Property 6: Mutual exclusion between extraction and consolidation** — verify `runOnce` skips extraction when `consolidating` is true and vice versa
    - **Validates: Requirements 3.1, 3.2**

  - [x] 9.3 Write property test for extraction rate limit (Property 15)
    - **Property 15: Extraction rate limit enforced** — simulate rapid extraction attempts, verify second attempt is skipped when within `extractionIntervalMs`
    - **Validates: Requirements 10.3**

  - [x] 9.4 Write property test for extraction enabled flag (Property 14)
    - **Property 14: Extraction runs if and only if enabled** — verify no extraction triggers evaluated when `extractionEnabled === false`
    - **Validates: Requirements 1.5, 10.1**

  - [x] 9.5 Write unit tests for daemon extraction integration
    - Test abort signal handling during extraction (Req 5.5)
    - Test log event names: `daemon:extraction-start`, `daemon:extraction-complete`, `daemon:extraction-failed` (Req 9.2, 9.3, 9.4)
    - Test initial extraction check on startup (Req 10.4)
    - Test shutdown rollback during extraction (Req 10.5)
    - _Requirements: 5.5, 9.2, 9.3, 9.4, 10.4, 10.5_

- [x] 10. Wire prompt/parse round-trip and cursor advance properties
  - [x] 10.1 Write property test for prompt/parse round-trip (Property 16)
    - **Property 16: Prompt build/parse round-trip** — generate inputs, build prompt, construct conforming JSON response, parse it, verify valid FileOperations
    - **Validates: Requirements 11.3**

  - [x] 10.2 Write property test for cursor advance on success only (Property 13)
    - **Property 13: Cursor advances on success only** — run extraction with success/failure, verify cursor behavior
    - **Validates: Requirements 8.1, 8.2**

  - [x] 10.3 Write property test for lock lifecycle (Property 7)
    - **Property 7: Lock lifecycle — release on success, rollback on failure** — run extraction pass, verify lock mtime advances on success and restores on failure
    - **Validates: Requirements 3.4, 3.5, 3.6**

- [x] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All new extraction code goes in `src/extraction/` directory
- The extraction engine reuses shared utilities exported from `consolidationEngine.ts`
- Tests use vitest + fast-check, following the same patterns as existing tests
