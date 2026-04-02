# Implementation Plan: memconsolidate

## Overview

Incremental build-out of the memconsolidate daemon in TypeScript. Each task builds on the previous, starting with shared types and utilities, then core subsystems (config, logger, frontmatter, lock), then the trigger system, consolidation engine, LLM backend, and finally the daemon loop with CLI entry point. Testing sub-tasks are optional and placed close to the code they validate.

## Tasks

- [x] 1. Project scaffolding and shared types
  - [x] 1.1 Initialize Node.js/TypeScript project
    - Run `npm init`, install TypeScript, ts-node, vitest, and toml parsing library (`@iarna/toml` or `smol-toml`)
    - Create `tsconfig.json` with strict mode, ESM output, `src/` root
    - Create the directory structure from the design: `src/`, `src/trigger/`, `src/lock/`, `src/consolidation/`, `src/llm/`, `src/memory/`
    - _Requirements: 7.1_

  - [x] 1.2 Define shared type definitions (`src/types.ts`)
    - Implement `MemconsolidateConfig`, `TriggerResult`, `LockState`, `ConsolidationResult`, `FileOperation`, `LlmResponse`, `LogEntry`, `IndexEntry`, `MemoryFrontmatter`, `ParsedMemoryFile`, `MemoryHeader` interfaces exactly as specified in the design
    - _Requirements: 4.1, 6.1, 7.2_

- [x] 2. Structured logger
  - [x] 2.1 Implement structured JSON-lines logger (`src/logger.ts`)
    - Implement `log(level, event, data?)` that writes a JSON line to stdout with `timestamp`, `level`, `event`, `data` fields
    - _Requirements: 11.3_

- [x] 3. Configuration loader
  - [x] 3.1 Implement config loading and validation (`src/config.ts`)
    - Implement `loadConfig(configPath?)` — reads TOML (or JSON fallback) from the given path or `memconsolidate.toml` in the memory directory
    - Implement `validateConfig(raw)` — validates all fields, applies defaults (`minHours: 24`, `minSessions: 5`, `staleLockThresholdMs: 3_600_000`, `maxIndexLines: 200`, `maxIndexBytes: 25_000`, `pollIntervalMs: 60_000`)
    - Support environment variable substitution in string values (e.g., `${OPENAI_API_KEY}`)
    - Exit with descriptive error on invalid values (negative `minHours`, etc.)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 3.2 Write unit tests for config loader
    - Test default application, TOML parsing, env var substitution, invalid value rejection
    - _Requirements: 7.3, 7.4_

- [x] 4. Memory file utilities
  - [x] 4.1 Implement memory type validation (`src/memory/memoryTypes.ts`)
    - Define `MemoryType` union type and `MEMORY_TYPES` array
    - Implement `parseMemoryType(raw)` returning `MemoryType | null`
    - _Requirements: 4.2, 4.3_

  - [x] 4.2 Implement frontmatter parser and serializer (`src/memory/frontmatter.ts`)
    - Implement `parseFrontmatter(raw)` using regex `/^---\s*\n([\s\S]*?)---\s*\n?/` to extract YAML block, parse with a YAML library, return `ParsedMemoryFile | null`
    - Implement `serializeFrontmatter(fm, body)` producing valid `---\n...\n---\n` + body output
    - Log warning and return null on malformed frontmatter
    - _Requirements: 4.1, 9.1, 9.2, 9.3, 9.4_

  - [x] 4.3 Write property test for frontmatter round-trip
    - For any valid `MemoryFrontmatter` and body string, `parseFrontmatter(serializeFrontmatter(fm, body))` produces an equivalent object
    - **Validates: Requirements 9.3**

  - [x] 4.4 Implement memory scanner (`src/memory/memoryScanner.ts`)
    - Implement `scanMemoryFiles(memoryDir, signal?)` — reads all `.md` files (excluding `MEMORY.md`), parses frontmatter, returns `MemoryHeader[]` sorted newest-first, capped at 200
    - Implement `formatMemoryManifest(memories)` — one-line-per-file text for prompt inclusion
    - _Requirements: 3.2, 4.4_

  - [x] 4.5 Implement memory age utilities (`src/memory/memoryAge.ts`)
    - Implement `memoryAgeDays(mtimeMs)`, `memoryAge(mtimeMs)`, `memoryFreshnessText(mtimeMs)`, `memoryFreshnessNote(mtimeMs)`
    - Staleness caveat for memories older than 1 day
    - _Requirements: 10.1, 10.2_

  - [x] 4.6 Write unit tests for memory utilities
    - Test frontmatter parsing edge cases (missing fields, unrecognized type, malformed YAML)
    - Test memory age computation and staleness text
    - Test memory type validation
    - _Requirements: 4.2, 4.3, 9.4, 10.2_

- [x] 5. Index manager
  - [x] 5.1 Implement index file read/write/truncate (`src/memory/indexManager.ts`)
    - Implement `readIndex(memoryDir)` — parse `MEMORY.md` lines into `IndexEntry[]`
    - Implement `writeIndex(memoryDir, entries)` — format and write entries
    - Implement `formatIndexEntry(entry)` — `- [Title](file.md) — description` format, max 150 chars per line
    - Implement `truncateIndexContent(raw, maxLines, maxBytes)` — enforce 200-line / 25 KB budget, append truncation warning, demote verbose entries (>200 chars)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 5.2 Write unit tests for index manager
    - Test line/byte truncation, warning appending, verbose entry demotion, round-trip read/write
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Lock manager
  - [x] 7.1 Implement PID-based lock file (`src/lock/consolidationLock.ts`)
    - Implement `readLockState(memoryDir, staleLockThresholdMs)` — read `.consolidate-lock`, check PID alive via `process.kill(pid, 0)`, compute staleness
    - Implement `tryAcquireLock(memoryDir, staleLockThresholdMs)` — write PID, re-read to detect race, yield if PID mismatch; reclaim stale locks
    - Implement `releaseLock(memoryDir)` — update mtime to now (success path)
    - Implement `rollbackLock(memoryDir, priorMtime)` — restore mtime to pre-acquisition value (failure path)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 7.2 Write unit tests for lock manager
    - Test acquire/release cycle, stale lock reclaim, race detection (PID mismatch), rollback on failure
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6_

- [x] 8. Trigger system
  - [x] 8.1 Implement time gate (`src/trigger/timeGate.ts`)
    - Implement `checkTimeGate(lastConsolidatedAt, minHours)` — returns true when elapsed hours >= minHours
    - _Requirements: 1.2_

  - [x] 8.2 Implement session gate (`src/trigger/sessionGate.ts`)
    - Implement `checkSessionGate(sessionDirectory, lastConsolidatedAt, minSessions)` — scan session dir for files with mtime > lastConsolidatedAt, return `{ passed, count }`
    - _Requirements: 1.3, 1.4_

  - [x] 8.3 Implement trigger system orchestrator (`src/trigger/triggerSystem.ts`)
    - Implement `evaluateTrigger(config, lastConsolidatedAt)` — check gates in order: time → session → lock; short-circuit on first failure
    - _Requirements: 1.1, 1.5, 1.6, 1.7, 1.8_

  - [x] 8.4 Write unit tests for trigger system
    - Test short-circuit behavior: time gate fail skips session+lock, session gate fail skips lock
    - Test gate pass-through when all gates pass
    - _Requirements: 1.1, 1.7, 1.8_

- [x] 9. LLM backend
  - [x] 9.1 Define LLM backend interface (`src/llm/llmBackend.ts`)
    - Export `LlmBackend` interface with `name`, `initialize(options)`, `consolidate(prompt)` methods
    - Export `FileOperation` and `LlmResponse` types (re-export from types.ts if defined there)
    - Interface must be stateless per requirement
    - _Requirements: 6.1, 6.5_

  - [x] 9.2 Implement OpenAI-compatible reference backend (`src/llm/openaiBackend.ts`)
    - Implement `OpenAIBackend` class implementing `LlmBackend`
    - `initialize` — create OpenAI client with API key and model from options
    - `consolidate` — send prompt as system message, parse structured JSON response into `LlmResponse`
    - Handle API errors with descriptive messages
    - _Requirements: 6.2, 6.3, 6.4_

  - [x] 9.3 Write unit tests for OpenAI backend
    - Mock HTTP responses, test response parsing into FileOperation[], test error handling
    - _Requirements: 6.2, 6.4_

- [x] 10. Consolidation engine
  - [x] 10.1 Implement prompt builder (`src/consolidation/promptBuilder.ts`)
    - Implement `buildConsolidationPrompt(memoryDir, sessionDir, extraContext?)` — reads memory state, builds a self-contained 4-phase prompt instructing the LLM to orient, gather, consolidate, prune
    - Include memory manifest, index contents, recent session info, and staleness caveats in the prompt
    - Instruct LLM to convert relative dates to absolute, delete contradicted facts, enforce index budget
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 10.3, 10.4_

  - [x] 10.2 Implement consolidation engine (`src/consolidation/consolidationEngine.ts`)
    - Implement `runConsolidation(config, backend, signal)` — orchestrate 4 phases:
      1. Orient: scan memory dir, read index, read memory files
      2. Gather: identify new info from recent files and sessions
      3. Consolidate: send prompt to LLM backend, apply returned file operations (create/update/delete)
      4. Prune: update MEMORY.md index, enforce size budget, remove stale entries
    - Validate frontmatter on all created/updated files
    - Support AbortSignal for graceful cancellation
    - Return `ConsolidationResult` with lists of files created/updated/deleted
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.4, 4.5, 5.1, 5.4_

  - [x] 10.3 Write unit tests for consolidation engine
    - Mock LLM backend, test that file operations are applied correctly, test index update after consolidation, test abort signal handling
    - _Requirements: 3.4, 3.7, 3.8_

- [x] 11. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Daemon and CLI entry point
  - [x] 12.1 Implement daemon class (`src/daemon.ts`)
    - Implement `MemconsolidateDaemon` class with `start()`, `stop()`, `runOnce()` methods
    - `start()` — validate config, initialize LLM backend, create memory dir if missing, perform initial gate check immediately, then poll on `pollIntervalMs`
    - `stop()` — complete or abort in-progress consolidation, rollback lock if needed, exit cleanly
    - `runOnce()` — single trigger evaluation + consolidation if gates pass
    - Watch memory directory for changes using polling (fs.watch optional enhancement)
    - _Requirements: 8.1, 8.2, 11.1, 11.4, 11.5_

  - [x] 12.2 Implement CLI entry point (`src/index.ts`)
    - Parse command-line arguments for config path
    - Instantiate daemon, call `start()`
    - Register SIGTERM/SIGINT handlers that call `stop()`
    - Log startup and shutdown events
    - _Requirements: 7.1, 11.1, 11.2, 11.3_

  - [x] 12.3 Write integration tests for daemon lifecycle
    - Test startup with valid config, graceful shutdown on SIGTERM, initial gate check on start, memory dir creation
    - _Requirements: 11.1, 11.2, 11.4, 11.5_

- [x] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirement clauses for traceability
- Checkpoints at tasks 6, 11, and 13 ensure incremental validation
- The LLM backend interface is stateless — each consolidation prompt is self-contained
- The filesystem is the primary interface — no SDK required for agents to write memories
