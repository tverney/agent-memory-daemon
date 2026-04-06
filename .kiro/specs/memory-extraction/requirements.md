# Requirements Document

## Introduction

This feature adds a second operational mode to the agent-memory-daemon: memory extraction. While the existing consolidation mode reorganizes and prunes existing memory files, extraction mode watches the session directory for new or modified session files, runs an LLM pass to identify key decisions, preferences, facts, and errors worth remembering, and writes them as individual memory files with YAML frontmatter to the memory directory. Extraction is inspired by Claude Code's `extractMemories` service and is designed to share infrastructure (config, LLM backends, lock manager, logger) with the existing consolidation engine.

## Glossary

- **Daemon**: The `MemconsolidateDaemon` class that orchestrates polling, trigger evaluation, and operational passes (consolidation and extraction)
- **Extraction_Engine**: The subsystem that analyzes session content via an LLM and produces individual memory files from identified facts, decisions, preferences, and errors
- **Extraction_Trigger**: The component that detects new or modified session files since the last extraction and decides whether an extraction pass should run
- **Extraction_Cursor**: A persistent marker (file mtime or timestamp) tracking which session content has already been processed, so only new content is analyzed
- **Session_File**: A markdown (.md), text (.txt), or JSONL (.jsonl) file in the session directory containing conversation transcripts
- **Memory_File**: A markdown file in the memory directory with YAML frontmatter (name, description, type) and a body containing durable knowledge
- **Memory_Manifest**: A formatted list of existing memory files with their frontmatter metadata, pre-injected into the extraction prompt so the LLM knows what already exists
- **MEMORY_Index**: The `MEMORY.md` file that serves as a navigable index of all memory files
- **Lock_Manager**: The PID-based lock system (`consolidationLock.ts`) that prevents concurrent operations on the memory directory
- **LLM_Backend**: The pluggable provider abstraction (`LlmBackend` interface) supporting OpenAI and Bedrock backends
- **Memory_Type**: One of four taxonomy values: `user` (preferences), `feedback` (corrections), `project` (architecture), `reference` (facts)
- **Config**: The `MemconsolidateConfig` type and TOML-based configuration system

## Requirements

### Requirement 1: Extraction Configuration

**User Story:** As a daemon operator, I want to configure extraction behavior independently from consolidation, so that I can enable, disable, and tune extraction without affecting consolidation.

#### Acceptance Criteria

1. THE Config SHALL support an `extraction_enabled` boolean field that defaults to `false`
2. THE Config SHALL support an `extraction_interval_ms` numeric field specifying the minimum interval between extraction passes, defaulting to 60000 (1 minute)
3. THE Config SHALL support a `max_extraction_session_chars` numeric field specifying the maximum characters to read from each session file during extraction, defaulting to 5000
4. WHEN `extraction_interval_ms` is set to a value less than 10000, THEN THE Config SHALL reject the value with a descriptive error message
5. WHEN `extraction_enabled` is `false`, THE Daemon SHALL skip all extraction trigger evaluation and LLM calls
6. THE Config SHALL map TOML snake_case keys (`extraction_enabled`, `extraction_interval_ms`, `max_extraction_session_chars`) to camelCase TypeScript fields using the existing `KEY_MAP` mechanism

### Requirement 2: Extraction Trigger System

**User Story:** As a daemon operator, I want extraction to run only when new session content is available, so that the daemon avoids unnecessary LLM calls.

#### Acceptance Criteria

1. WHEN the Daemon polls, THE Extraction_Trigger SHALL compare each Session_File's modification time against the Extraction_Cursor to identify files modified since the last extraction
2. WHEN no Session_Files have been modified since the Extraction_Cursor, THE Extraction_Trigger SHALL report that extraction is not needed
3. WHEN at least one Session_File has been modified since the Extraction_Cursor, THE Extraction_Trigger SHALL report that extraction is needed and provide the list of modified session file paths
4. THE Extraction_Trigger SHALL support the same session file formats as the consolidation engine: markdown (.md), text (.txt), and JSONL (.jsonl)
5. THE Extraction_Cursor SHALL persist as a timestamp file (`.extraction-cursor`) in the memory directory so that the cursor survives daemon restarts
6. WHEN the cursor file does not exist, THE Extraction_Trigger SHALL treat all session files as new and process them on the first run

### Requirement 3: Mutual Exclusion with Consolidation

**User Story:** As a daemon operator, I want extraction and consolidation to never run simultaneously, so that concurrent writes to the memory directory are prevented.

#### Acceptance Criteria

1. WHEN an extraction pass is in progress, THE Daemon SHALL skip consolidation trigger evaluation until the extraction pass completes
2. WHEN a consolidation pass is in progress, THE Daemon SHALL skip extraction trigger evaluation until the consolidation pass completes
3. THE Daemon SHALL use the existing Lock_Manager to acquire the lock before starting an extraction pass
4. IF the lock cannot be acquired because another operation holds it, THEN THE Daemon SHALL skip the extraction pass and retry on the next poll cycle
5. WHEN an extraction pass completes successfully, THE Daemon SHALL release the lock
6. IF an extraction pass fails, THEN THE Daemon SHALL roll back the lock mtime to its pre-acquisition value

### Requirement 4: Extraction Prompt Construction

**User Story:** As a daemon operator, I want the extraction LLM prompt to include existing memory context, so that the LLM avoids creating duplicate memories and updates existing files instead.

#### Acceptance Criteria

1. THE Extraction_Engine SHALL build a prompt that includes the Memory_Manifest of all existing memory files with their frontmatter metadata
2. THE Extraction_Engine SHALL include the content of modified session files in the prompt, truncated to `max_extraction_session_chars` per file
3. THE Extraction_Engine SHALL instruct the LLM to identify facts, decisions, user preferences, and error corrections worth remembering from the session content
4. THE Extraction_Engine SHALL instruct the LLM to check the Memory_Manifest before creating new files and to update existing files when the topic overlaps
5. THE Extraction_Engine SHALL instruct the LLM to classify each memory using the Memory_Type taxonomy: `user`, `feedback`, `project`, `reference`
6. THE Extraction_Engine SHALL instruct the LLM to return file operations in the same JSON format used by the consolidation engine (`{ operations: FileOperation[], reasoning: string }`)
7. THE Extraction_Engine SHALL include the current date in the prompt so the LLM can convert relative date references to absolute dates

### Requirement 5: Extraction LLM Interaction

**User Story:** As a daemon operator, I want extraction to use the same LLM backend infrastructure as consolidation, so that I do not need separate LLM credentials or configuration.

#### Acceptance Criteria

1. THE Extraction_Engine SHALL use the configured LLM_Backend (OpenAI or Bedrock) to send the extraction prompt
2. THE Extraction_Engine SHALL reuse the existing `LlmBackend.consolidate()` method to send the extraction prompt and receive file operations
3. WHEN the LLM call fails with a transient error (5xx or 429), THE Extraction_Engine SHALL retry with exponential backoff up to 3 times
4. WHEN the LLM call fails with a client error (4xx except 429), THE Extraction_Engine SHALL not retry and log the error
5. THE Extraction_Engine SHALL respect the AbortSignal for graceful cancellation during LLM calls

### Requirement 6: Memory File Writing

**User Story:** As a daemon operator, I want extracted memories to be written in the same format as consolidated memories, so that both modes produce interchangeable output.

#### Acceptance Criteria

1. THE Extraction_Engine SHALL write each extracted memory as a markdown file with YAML frontmatter containing `name`, `description`, and `type` fields
2. THE Extraction_Engine SHALL validate that each file operation path is a simple filename (no path traversal, no absolute paths, must end in `.md`, must not target `MEMORY.md`)
3. THE Extraction_Engine SHALL validate that each created or updated file has valid YAML frontmatter with a non-empty `name` field before writing
4. WHEN the LLM returns an `update` operation for an existing file, THE Extraction_Engine SHALL overwrite the file with the new content
5. WHEN the LLM returns a `create` operation, THE Extraction_Engine SHALL write the new file to the memory directory
6. WHEN `dry_run` is `true` in the Config, THE Extraction_Engine SHALL log the operations without writing any files
7. THE Extraction_Engine SHALL use the `serializeFrontmatter` function from the existing frontmatter module when the LLM does not provide raw frontmatter content

### Requirement 7: MEMORY.md Index Update After Extraction

**User Story:** As a daemon operator, I want the MEMORY.md index to be updated after each extraction pass, so that new memories are discoverable.

#### Acceptance Criteria

1. WHEN an extraction pass creates or updates memory files, THE Extraction_Engine SHALL update the MEMORY_Index with entries for the new or modified files
2. THE Extraction_Engine SHALL use the existing `readIndex`, `writeIndex`, and `truncateIndexContent` functions from the index manager
3. THE Extraction_Engine SHALL enforce the same index size budget as consolidation: 200 lines maximum and 25 KB maximum
4. WHEN an extraction pass produces no file operations, THE Extraction_Engine SHALL not modify the MEMORY_Index

### Requirement 8: Extraction Cursor Management

**User Story:** As a daemon operator, I want the extraction cursor to advance only after a successful extraction, so that failed extractions are retried with the same session content.

#### Acceptance Criteria

1. WHEN an extraction pass completes successfully, THE Extraction_Engine SHALL update the Extraction_Cursor to the current timestamp
2. IF an extraction pass fails, THEN THE Extraction_Engine SHALL leave the Extraction_Cursor unchanged so the same session content is reprocessed on the next attempt
3. THE Extraction_Cursor SHALL be stored as a file (`.extraction-cursor`) in the memory directory containing the timestamp in milliseconds
4. WHEN reading the Extraction_Cursor, THE Extraction_Engine SHALL parse the file content as a numeric timestamp in milliseconds

### Requirement 9: Extraction Result Reporting

**User Story:** As a daemon operator, I want extraction results to be logged in the same structured format as consolidation results, so that I can monitor extraction activity.

#### Acceptance Criteria

1. THE Extraction_Engine SHALL return an `ExtractionResult` containing: files created, files updated, duration in milliseconds, prompt length, operations requested, operations applied, and operations skipped
2. THE Daemon SHALL log the ExtractionResult using the existing structured logger with event name `daemon:extraction-complete`
3. WHEN an extraction pass fails, THE Daemon SHALL log the error with event name `daemon:extraction-failed`
4. THE Daemon SHALL log the start of each extraction pass with event name `daemon:extraction-start` including the count of modified session files

### Requirement 10: Daemon Integration

**User Story:** As a daemon operator, I want extraction to run alongside consolidation in the same daemon polling loop, so that I do not need a separate process.

#### Acceptance Criteria

1. THE Daemon SHALL evaluate extraction triggers on each poll cycle when `extraction_enabled` is `true`
2. THE Daemon SHALL evaluate extraction triggers independently from consolidation triggers, respecting the mutual exclusion constraint from Requirement 3
3. THE Daemon SHALL enforce the `extraction_interval_ms` minimum interval between extraction passes using a rate limiter
4. WHEN the Daemon starts, THE Daemon SHALL perform an initial extraction check immediately (same as the existing initial consolidation check)
5. WHEN the Daemon stops, THE Daemon SHALL abort any in-progress extraction pass and roll back the lock

### Requirement 11: Extraction Prompt Parsing and Serialization

**User Story:** As a daemon operator, I want the extraction prompt to be serializable and the LLM response to be parseable, so that the extraction pipeline is testable end-to-end.

#### Acceptance Criteria

1. THE Extraction_Engine SHALL build the extraction prompt as a single string suitable for the `LlmBackend.consolidate()` method
2. THE Extraction_Engine SHALL parse the LLM response using the same `LlmResponse` type (`{ operations: FileOperation[], reasoning?: string }`) used by consolidation
3. FOR ALL valid extraction prompts, building the prompt then parsing a conforming LLM response SHALL produce a valid list of `FileOperation` objects (round-trip property)
4. THE Extraction_Engine SHALL serialize the extraction prompt using a dedicated `buildExtractionPrompt` function analogous to the existing `buildConsolidationPrompt`
