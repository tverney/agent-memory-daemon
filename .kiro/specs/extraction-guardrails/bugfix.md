# Bugfix Requirements Document

## Introduction

The extraction engine (`src/extraction/`) creates memory files without any upper bound. Each extraction pass can create new files, and subsequent passes see those new files in the memory manifest, potentially prompting the LLM to create even more files — leading to exponential growth. Three missing guardrails contribute to this:

1. No maximum memory file count — the engine applies every `create` operation the LLM returns regardless of how many memory files already exist.
2. No prompt size budget enforcement — `maxPromptChars` exists in config but is never checked in `buildExtractionPrompt`, so the prompt grows unboundedly as memory files accumulate.
3. No per-pass cap on file creation — the LLM can return an unlimited number of `create` operations in a single extraction pass.

Together these cause runaway file creation where each pass feeds the next, spiraling the memory directory.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN extraction runs and the LLM returns N create operations THEN the system applies all N operations with no upper bound on total memory file count in the directory.

1.2 WHEN the memory manifest grows large due to accumulated files THEN the system includes the entire manifest in the prompt without enforcing `maxPromptChars`, causing prompt size to grow unboundedly.

1.3 WHEN the LLM returns more create operations than is reasonable for a single pass THEN the system applies all of them, allowing a single pass to create an arbitrarily large number of new files.

1.4 WHEN extraction runs on sessions that were already fully processed in a prior pass but whose mtime was updated (e.g., appended to) THEN the system reprocesses the entire session content, potentially creating duplicate memories for facts already extracted.

### Expected Behavior (Correct)

2.1 WHEN extraction runs and the total memory file count in the directory already meets or exceeds `maxFilesPerBatch` (or a new `maxMemoryFiles` config limit) THEN the system SHALL skip file creation operations and log a warning, preventing unbounded file growth.

2.2 WHEN building the extraction prompt THEN the system SHALL enforce `maxPromptChars` by truncating or omitting manifest and session content so the total prompt length does not exceed the configured budget.

2.3 WHEN the LLM returns create operations in a single pass THEN the system SHALL apply at most `maxFilesPerBatch` create operations per extraction pass, skipping any excess and logging the skip.

2.4 WHEN extraction runs on sessions that were already processed THEN the system SHALL track which session files have been processed (not just a global timestamp) so that only genuinely new or modified content triggers reprocessing.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN extraction is disabled (`extractionEnabled: false`) THEN the system SHALL CONTINUE TO skip extraction entirely.

3.2 WHEN the LLM returns valid update operations for existing memory files THEN the system SHALL CONTINUE TO apply those updates normally (updates are not subject to the file creation cap).

3.3 WHEN the LLM returns operations targeting `MEMORY.md` THEN the system SHALL CONTINUE TO filter them out and manage the index separately.

3.4 WHEN the LLM returns operations with unsafe paths or invalid content THEN the system SHALL CONTINUE TO skip them with a warning log.

3.5 WHEN no session files have been modified since the cursor THEN the system SHALL CONTINUE TO skip extraction (trigger returns `triggered: false`).

3.6 WHEN extraction completes successfully THEN the system SHALL CONTINUE TO advance the extraction cursor and release the lock.
