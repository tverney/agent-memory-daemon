# Requirements Document

## Introduction

memconsolidate is a standalone, language-agnostic memory consolidation daemon that any AI coding agent can plug into. Agents feed it raw observations as markdown files; the daemon periodically runs a four-phase consolidation pass (orient, gather, consolidate, prune) to produce organized, durable memory. The LLM backend is pluggable — not locked to any specific provider. The project is designed for open-source community adoption.

## Glossary

- **Daemon**: The long-running memconsolidate process that watches a memory directory and triggers consolidation passes
- **Memory_Directory**: The root directory containing all memory files, the index, and the lock file
- **Memory_File**: A markdown file with YAML frontmatter (name, description, type fields) storing a single topic's observations
- **Index_File**: The `MEMORY.md` file at the root of the Memory_Directory serving as a one-line-per-entry pointer index to Memory_Files
- **Consolidation_Pass**: The four-phase process (orient → gather → consolidate → prune) that organizes raw observations into durable memory
- **Trigger_System**: The three-gate mechanism (time gate, session gate, lock gate) that decides when a Consolidation_Pass should fire
- **Time_Gate**: A check that a configurable minimum number of hours has elapsed since the last consolidation
- **Session_Gate**: A check that a configurable minimum number of sessions have been touched since the last consolidation
- **Lock_Gate**: A check that no other process is currently mid-consolidation, enforced via a PID-based lock file
- **Lock_File**: A file whose mtime represents the last consolidation timestamp and whose body contains the holder's PID
- **LLM_Backend**: A pluggable interface through which the Daemon sends consolidation prompts and receives structured responses
- **Memory_Type**: One of four categories — `user`, `feedback`, `project`, `reference` — constraining what kind of observation a Memory_File stores
- **Session_Directory**: A directory containing session transcript files (JSONL or similar) that the Daemon scans for session count
- **Size_Budget**: The maximum line count (200 lines) and byte count (25 KB) enforced on the Index_File
- **Frontmatter**: YAML metadata block at the top of each Memory_File containing `name`, `description`, and `type` fields
- **Stale_Lock**: A Lock_File whose mtime is older than the configurable staleness threshold (default 1 hour), regardless of whether the holder PID is alive

## Requirements

### Requirement 1: Three-Gate Trigger System

**User Story:** As an AI agent operator, I want the daemon to use a three-gate trigger system so that consolidation runs only when meaningful new signal has accumulated and no other process is already consolidating.

#### Acceptance Criteria

1. WHEN the Daemon evaluates whether to trigger a Consolidation_Pass, THE Trigger_System SHALL check gates in cheapest-first order: Time_Gate, then Session_Gate, then Lock_Gate
2. THE Time_Gate SHALL pass only when the number of hours since the last consolidation is greater than or equal to a configurable `minHours` threshold (default: 24)
3. WHEN the Time_Gate passes, THE Session_Gate SHALL count session transcript files in the Session_Directory with mtime newer than the last consolidation timestamp
4. THE Session_Gate SHALL pass only when the count of recently-touched sessions is greater than or equal to a configurable `minSessions` threshold (default: 5)
5. WHEN both the Time_Gate and Session_Gate pass, THE Lock_Gate SHALL check whether the Lock_File indicates an active consolidation by another process
6. THE Lock_Gate SHALL pass only when no Lock_File exists, or the existing Lock_File is a Stale_Lock, or the holder PID is no longer running
7. IF the Time_Gate does not pass, THEN THE Trigger_System SHALL skip the Session_Gate and Lock_Gate checks entirely
8. IF the Session_Gate does not pass, THEN THE Trigger_System SHALL skip the Lock_Gate check entirely

### Requirement 2: Lock File Management

**User Story:** As an AI agent operator, I want a PID-based lock file so that concurrent daemon instances do not corrupt memory files during consolidation.

#### Acceptance Criteria

1. WHEN the Lock_Gate passes and the Daemon begins a Consolidation_Pass, THE Daemon SHALL write the current process PID to the Lock_File and set its mtime to the current time
2. WHEN a Consolidation_Pass completes successfully, THE Daemon SHALL leave the Lock_File in place with its mtime representing the completion timestamp
3. IF a Consolidation_Pass fails, THEN THE Daemon SHALL roll back the Lock_File mtime to its pre-acquisition value
4. THE Daemon SHALL treat a Lock_File as a Stale_Lock when its mtime is older than a configurable staleness threshold (default: 1 hour)
5. WHEN the Lock_File contains a PID that is no longer running, THE Daemon SHALL reclaim the lock by overwriting the Lock_File with its own PID
6. WHEN two processes attempt to acquire the Lock_File simultaneously, THE Daemon SHALL re-read the Lock_File after writing and yield if the PID in the file does not match its own
7. IF the Lock_File mtime is older than the staleness threshold, THEN THE Daemon SHALL reclaim the lock regardless of whether the holder PID is still running

### Requirement 3: Four-Phase Consolidation Pass

**User Story:** As an AI agent operator, I want the daemon to run a structured four-phase consolidation so that raw observations are systematically organized into durable, well-indexed memory.

#### Acceptance Criteria

1. THE Consolidation_Pass SHALL execute four phases in strict order: Orient, Gather, Consolidate, Prune
2. DURING the Orient phase, THE Daemon SHALL list the Memory_Directory contents, read the Index_File, and read existing Memory_Files to understand current state
3. DURING the Gather phase, THE Daemon SHALL identify new information from recently modified Memory_Files, daily log files, and optionally session transcripts
4. DURING the Consolidate phase, THE Daemon SHALL write new Memory_Files or update existing Memory_Files by merging new signal into existing topic files
5. DURING the Consolidate phase, THE Daemon SHALL convert relative date references (e.g., "yesterday", "last week") to absolute dates (e.g., "2025-07-15")
6. DURING the Consolidate phase, THE Daemon SHALL delete or correct facts in Memory_Files that are contradicted by newer observations
7. DURING the Prune phase, THE Daemon SHALL update the Index_File to reflect the current set of Memory_Files
8. DURING the Prune phase, THE Daemon SHALL remove Index_File entries that point to deleted or superseded Memory_Files
9. DURING the Prune phase, THE Daemon SHALL enforce the Size_Budget on the Index_File

### Requirement 4: Memory File Format

**User Story:** As an AI agent developer, I want a well-defined memory file format so that any agent can read and write memories without ambiguity.

#### Acceptance Criteria

1. THE Daemon SHALL store each memory as a markdown file with YAML Frontmatter containing `name`, `description`, and `type` fields
2. THE Daemon SHALL validate that the `type` field in each Memory_File Frontmatter is one of the four defined Memory_Types: `user`, `feedback`, `project`, `reference`
3. IF a Memory_File contains an unrecognized `type` value, THEN THE Daemon SHALL log a warning and treat the file as valid but untyped during consolidation
4. THE Daemon SHALL organize Memory_Files semantically by topic, not chronologically
5. THE Daemon SHALL merge new observations into existing topic-matched Memory_Files rather than creating near-duplicate files

### Requirement 5: Index File Management

**User Story:** As an AI agent developer, I want the MEMORY.md index to stay concise and within a size budget so that agents can load it into context without exceeding token limits.

#### Acceptance Criteria

1. THE Index_File SHALL contain one-line entries in the format `- [Title](file.md) — one-line description`, each under 150 characters
2. THE Daemon SHALL enforce a maximum of 200 lines on the Index_File
3. THE Daemon SHALL enforce a maximum of 25 KB on the Index_File
4. WHEN the Index_File exceeds the Size_Budget after a Consolidation_Pass, THE Daemon SHALL truncate the Index_File to fit within both the line and byte limits
5. WHEN truncating the Index_File, THE Daemon SHALL append a warning indicating that the index was truncated and specifying which limit was exceeded
6. THE Daemon SHALL demote verbose index entries (over 200 characters) by shortening the line and moving detail into the referenced Memory_File

### Requirement 6: Pluggable LLM Backend

**User Story:** As an AI agent developer, I want the LLM backend to be pluggable so that I can use any LLM provider (OpenAI, Anthropic, local models, etc.) for the consolidation reasoning.

#### Acceptance Criteria

1. THE Daemon SHALL define an LLM_Backend interface that accepts a consolidation prompt (string) and returns a structured response containing file operations (create, update, delete)
2. THE Daemon SHALL ship with at least one reference LLM_Backend implementation
3. WHEN the Daemon starts, THE Daemon SHALL load the LLM_Backend specified in the configuration
4. IF the configured LLM_Backend fails to load, THEN THE Daemon SHALL exit with a descriptive error message naming the backend and the failure reason
5. THE LLM_Backend interface SHALL be stateless — each consolidation prompt is a self-contained request with no dependency on prior calls

### Requirement 7: Configuration

**User Story:** As an AI agent operator, I want to configure the daemon via a configuration file so that I can tune trigger thresholds, paths, and backend selection without modifying code.

#### Acceptance Criteria

1. THE Daemon SHALL read configuration from a file (e.g., `memconsolidate.toml` or `memconsolidate.json`) in the Memory_Directory or a path specified via command-line argument
2. THE Daemon SHALL support configuring: `minHours`, `minSessions`, `staleLockThresholdMs`, `maxIndexLines`, `maxIndexBytes`, `memoryDirectory`, `sessionDirectory`, and `llmBackend`
3. THE Daemon SHALL apply sensible defaults for all configuration values when not explicitly set
4. WHEN a configuration value is invalid (e.g., negative `minHours`), THE Daemon SHALL reject the value and exit with a descriptive error message

### Requirement 8: Language-Agnostic Interface

**User Story:** As an AI agent developer using any programming language, I want to interact with memconsolidate through the filesystem so that no language-specific SDK is required.

#### Acceptance Criteria

1. THE Daemon SHALL use the filesystem as the primary interface — agents write markdown files to the Memory_Directory, and the Daemon reads and consolidates them
2. THE Daemon SHALL watch the Memory_Directory for changes using filesystem events or polling at a configurable interval
3. THE Daemon SHALL not require agents to use any language-specific client library or SDK to submit observations
4. THE Daemon SHALL document the Memory_File format, Frontmatter schema, and directory layout so that any agent can produce conformant files

### Requirement 9: Memory Frontmatter Parsing and Serialization

**User Story:** As an AI agent developer, I want the daemon to reliably parse and serialize YAML frontmatter so that memory metadata is never lost or corrupted during consolidation.

#### Acceptance Criteria

1. WHEN a Memory_File with valid YAML Frontmatter is read, THE Daemon SHALL parse the Frontmatter into a structured object containing `name`, `description`, and `type` fields
2. WHEN the Daemon writes or updates a Memory_File, THE Daemon SHALL serialize the structured Frontmatter object back into valid YAML Frontmatter followed by the markdown body
3. FOR ALL valid Memory_Files, parsing the Frontmatter then serializing it back then parsing again SHALL produce an equivalent structured object (round-trip property)
4. IF a Memory_File contains malformed YAML Frontmatter, THEN THE Daemon SHALL log a warning with the file path and the parse error, and skip the file during consolidation

### Requirement 10: Staleness Awareness

**User Story:** As an AI agent developer, I want the daemon to track memory age so that stale observations are flagged and agents can make informed decisions about trust.

#### Acceptance Criteria

1. THE Daemon SHALL compute the age of each Memory_File based on its filesystem mtime
2. WHEN a Memory_File is older than 1 day, THE Daemon SHALL include a staleness caveat when the memory is referenced, indicating the memory is a point-in-time observation
3. DURING the Consolidate phase, WHEN a Memory_File contains facts contradicted by newer observations, THE Daemon SHALL update or remove the stale facts
4. THE Daemon SHALL not store information that is derivable from the current project state (code patterns, architecture, file structure, git history)

### Requirement 11: Daemon Lifecycle

**User Story:** As an AI agent operator, I want the daemon to start, run, and stop cleanly so that it integrates well into existing process management workflows.

#### Acceptance Criteria

1. WHEN started, THE Daemon SHALL validate configuration, initialize the LLM_Backend, and begin watching the Memory_Directory
2. WHEN a termination signal (SIGTERM, SIGINT) is received, THE Daemon SHALL complete or abort any in-progress Consolidation_Pass, roll back the Lock_File if needed, and exit cleanly
3. THE Daemon SHALL log consolidation events (trigger fired, phase transitions, files touched, completion, errors) to stdout in a structured format (JSON lines)
4. IF the Memory_Directory does not exist at startup, THEN THE Daemon SHALL create it recursively
5. WHEN the Daemon starts, THE Daemon SHALL perform an initial gate check immediately rather than waiting for the first polling interval
