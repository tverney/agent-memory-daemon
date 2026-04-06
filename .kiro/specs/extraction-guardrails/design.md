# Extraction Guardrails Bugfix Design

## Overview

The extraction engine applies every file operation the LLM returns without enforcing any upper bounds on total memory file count, prompt size, per-pass file creation, or per-session processing tracking. This causes runaway file growth where each pass feeds the next — more files produce a larger manifest, which produces a larger prompt, which causes the LLM to create even more files.

The fix introduces four guardrails:
1. A `maxMemoryFiles` config cap that blocks `create` operations once the directory reaches the limit.
2. Prompt budget enforcement in `buildExtractionPrompt` that respects `maxPromptChars`.
3. A per-pass creation cap using `maxFilesPerBatch` inside `runExtraction`.
4. Per-session cursor tracking in `cursorManager` so already-processed sessions are not re-extracted.

## Glossary

- **Bug_Condition (C)**: Any extraction pass where at least one of the four guardrails is missing — unbounded file count, unbounded prompt size, unbounded per-pass creation, or duplicate session reprocessing.
- **Property (P)**: After the fix, extraction respects all four caps and only processes genuinely new/modified session content.
- **Preservation**: Existing behaviors — update operations, unsafe-path rejection, MEMORY.md filtering, trigger gating, cursor advancement, dry-run mode — must remain unchanged.
- **runExtraction**: The function in `src/extraction/extractionEngine.ts` that orchestrates a single extraction pass (prompt → LLM → validate → apply → index).
- **buildExtractionPrompt**: The function in `src/extraction/extractionPromptBuilder.ts` that assembles the prompt from memory manifest and session content.
- **cursorManager**: The module `src/extraction/cursorManager.ts` that persists the extraction cursor as a single Unix timestamp.
- **maxMemoryFiles**: New config field — hard cap on total `.md` files (excluding `MEMORY.md`) in the memory directory.
- **maxFilesPerBatch**: Existing config field — reused as the per-pass creation cap in extraction.

## Bug Details

### Bug Condition

The bug manifests when extraction runs without any of the four guardrails. The engine blindly applies every `create` operation the LLM returns, builds prompts of unbounded size, and reprocesses sessions whose content was already extracted.

**Formal Specification:**
```
FUNCTION isBugCondition(state, llmResponse)
  INPUT: state of type { memoryDir, config, sessionFiles, cursorType }
         llmResponse of type { operations: FileOperation[] }
  OUTPUT: boolean

  existingFileCount := countMdFiles(state.memoryDir)  // excludes MEMORY.md
  createOps := llmResponse.operations.filter(op => op.op == 'create')
  promptLength := buildExtractionPrompt(...).length

  noFileCap       := existingFileCount + createOps.length > state.config.maxMemoryFiles
                     AND system does NOT enforce maxMemoryFiles
  noPromptBudget  := promptLength > state.config.maxPromptChars
                     AND system does NOT truncate prompt to maxPromptChars
  noPerPassCap    := createOps.length > state.config.maxFilesPerBatch
                     AND system does NOT cap create ops per pass
  noSessionTrack  := state.cursorType == 'global-timestamp-only'
                     AND sessionFiles includes already-processed content

  RETURN noFileCap OR noPromptBudget OR noPerPassCap OR noSessionTrack
END FUNCTION
```

### Examples

- **Unbounded file count**: Memory directory has 95 files, `maxMemoryFiles` is 100, LLM returns 20 create ops → current code applies all 20, reaching 115 files. Fixed code applies only 5 and skips the remaining 15.
- **Unbounded prompt**: Memory manifest is 80,000 chars, session content is 50,000 chars, `maxPromptChars` is 120,000 → current code builds a 130,000+ char prompt. Fixed code truncates manifest/sessions to fit within 120,000.
- **Per-pass flood**: LLM returns 50 create operations in one pass, `maxFilesPerBatch` is 30 → current code applies all 50. Fixed code applies 30 and skips 20.
- **Duplicate reprocessing**: Session file `session-001.md` was fully processed in pass N, then appended to before pass N+1 → current code reprocesses the entire file. Fixed code tracks per-session offsets so only the new content is included.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Update operations on existing memory files continue to be applied normally (not subject to creation caps).
- Operations with unsafe paths or invalid frontmatter continue to be skipped with warning logs.
- Operations targeting `MEMORY.md` continue to be filtered out before application.
- When `extractionEnabled: false`, extraction is skipped entirely.
- When no session files have been modified since the cursor, extraction trigger returns `triggered: false`.
- On successful extraction, the cursor is advanced and the lock is released.
- Dry-run mode continues to log operations without writing to disk.
- Delete operations continue to work as before.

**Scope:**
All inputs that do NOT trigger any of the four guardrails should be completely unaffected by this fix. This includes:
- Extraction passes where file count is below `maxMemoryFiles` and create ops are below `maxFilesPerBatch`
- Prompts that already fit within `maxPromptChars`
- Sessions that are genuinely new (not previously processed)

## Hypothesized Root Cause

Based on the bug description, the four defects are:

1. **No maxMemoryFiles enforcement in extractionEngine.ts**: `runExtraction` iterates over all LLM-returned operations and applies every valid one. There is no check against the current file count in the memory directory. The `scanMemoryFiles` function in `memoryScanner.ts` has a `MAX_MEMORIES = 200` constant for manifest display, but this is never used as a creation gate.

2. **No prompt budget enforcement in extractionPromptBuilder.ts**: `buildExtractionPrompt` truncates the manifest to `maxMemoryChars` and each session to `maxSessionChars`, but never checks the total assembled prompt length against `maxPromptChars`. The config field exists and is validated but unused in extraction.

3. **No per-pass creation cap in extractionEngine.ts**: The operation loop in `runExtraction` applies every valid `create` operation. There is no counter or cap. The `maxFilesPerBatch` config field is used in the consolidation chunk planner but not in extraction.

4. **Global-timestamp cursor in cursorManager.ts**: The cursor is a single Unix timestamp. When a session file is appended to (mtime updated), the entire file is re-read and re-included in the prompt, causing the LLM to potentially re-extract facts it already created memory files for. There is no per-session offset or hash tracking.

## Correctness Properties

Property 1: Bug Condition - File creation respects maxMemoryFiles cap

_For any_ extraction pass where the memory directory already contains N files and the LLM returns C create operations, the fixed `runExtraction` function SHALL apply at most `max(0, maxMemoryFiles - N)` create operations, skipping the rest and logging each skip.

**Validates: Requirements 2.1**

Property 2: Bug Condition - Prompt size respects maxPromptChars budget

_For any_ call to `buildExtractionPrompt` with any number of memory files and session files, the returned prompt string SHALL have length ≤ `maxPromptChars`.

**Validates: Requirements 2.2**

Property 3: Bug Condition - Per-pass creation respects maxFilesPerBatch

_For any_ extraction pass where the LLM returns C create operations and C > `maxFilesPerBatch`, the fixed `runExtraction` function SHALL apply at most `maxFilesPerBatch` create operations per pass.

**Validates: Requirements 2.3**

Property 4: Bug Condition - Per-session cursor prevents duplicate reprocessing

_For any_ extraction pass where a session file was fully processed in a prior pass and has not been modified since, the fixed cursor manager SHALL exclude that session from the modified files list.

**Validates: Requirements 2.4**

Property 5: Preservation - Update operations unaffected by creation caps

_For any_ extraction pass where the LLM returns update operations alongside create operations, the fixed code SHALL apply all valid update operations regardless of the creation cap, preserving existing update behavior.

**Validates: Requirements 3.2**

Property 6: Preservation - Existing validation and filtering unchanged

_For any_ extraction pass, the fixed code SHALL continue to reject unsafe paths, invalid frontmatter, and MEMORY.md-targeting operations exactly as before, preserving all existing validation behavior.

**Validates: Requirements 3.3, 3.4**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/types.ts`

**Specific Changes**:
1. **Add `maxMemoryFiles` to `MemconsolidateConfig`**: New numeric field with a sensible default (e.g., 100).
2. **Add `SessionCursor` type**: A record mapping session filenames to their last-processed byte offset or content hash, replacing the single-timestamp cursor.

**File**: `src/config.ts`

**Specific Changes**:
3. **Add `maxMemoryFiles` default and validation**: Default to 100, validate ≥ 1. Add snake_case mapping `max_memory_files`.

**File**: `src/extraction/extractionEngine.ts`

**Function**: `runExtraction`

**Specific Changes**:
4. **Count existing memory files before applying operations**: Call `scanMemoryFiles` (or `fs.readdir` + filter) to get the current file count.
5. **Enforce maxMemoryFiles cap**: Track a `createdCount` counter. Before applying each `create` operation, check `existingFileCount + createdCount < config.maxMemoryFiles`. If at cap, skip the operation, increment `operationsSkipped`, and log a warning.
6. **Enforce maxFilesPerBatch cap on creates**: Also check `createdCount < config.maxFilesPerBatch` before applying each create. The effective cap is `min(maxMemoryFiles - existingCount, maxFilesPerBatch)`.

**File**: `src/extraction/extractionPromptBuilder.ts`

**Function**: `buildExtractionPrompt`

**Specific Changes**:
7. **Accept `maxPromptChars` parameter**: Add it to the function signature.
8. **Enforce prompt budget**: After assembling all sections, check total length. If over budget, progressively truncate: first trim session blocks (newest first), then trim manifest. Return the truncated prompt.

**File**: `src/extraction/cursorManager.ts`

**Specific Changes**:
9. **Replace single-timestamp cursor with per-session cursor**: Change the cursor file format from a single number to a JSON object mapping `{ [filename]: { offset: number, mtimeMs: number } }`.
10. **Add `readSessionCursor` / `writeSessionCursor`**: New functions that read/write the JSON cursor. Maintain backward compatibility — if the file contains a plain number, treat it as a legacy cursor and migrate.
11. **Add `getUnprocessedSessions`**: Given the cursor map and the current session directory listing, return only sessions that are new or have been modified (mtime changed) since last processing, along with the byte offset to resume from.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that create a memory directory with many files, build prompts, and run extraction with a mock LLM that returns excessive create operations. Run these tests on the UNFIXED code to observe that no caps are enforced.

**Test Cases**:
1. **Unbounded File Count Test**: Set up 95 memory files, mock LLM returns 20 creates, verify all 20 are applied (will demonstrate bug on unfixed code)
2. **Unbounded Prompt Size Test**: Set up large manifest + sessions, call `buildExtractionPrompt`, verify prompt exceeds `maxPromptChars` (will demonstrate bug on unfixed code)
3. **Per-Pass Flood Test**: Mock LLM returns 50 create ops with `maxFilesPerBatch=30`, verify all 50 are applied (will demonstrate bug on unfixed code)
4. **Duplicate Reprocessing Test**: Process a session, append to it, re-run extraction, verify entire session is re-included (will demonstrate bug on unfixed code)

**Expected Counterexamples**:
- All create operations applied regardless of directory file count
- Prompt length exceeds `maxPromptChars` when manifest + sessions are large
- Possible causes: missing cap checks in `runExtraction`, missing budget enforcement in `buildExtractionPrompt`, global-timestamp cursor

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL (memoryDir, config, llmResponse) WHERE isBugCondition(memoryDir, config, llmResponse) DO
  result := runExtraction_fixed(config, mockBackend(llmResponse), sessions, signal)
  existingCount := countMdFiles(memoryDir)
  ASSERT existingCount <= config.maxMemoryFiles
  ASSERT result.filesCreated.length <= config.maxFilesPerBatch
  ASSERT promptUsed.length <= config.maxPromptChars
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL (memoryDir, config, llmResponse) WHERE NOT isBugCondition(memoryDir, config, llmResponse) DO
  ASSERT runExtraction_original(config, backend, sessions, signal)
       = runExtraction_fixed(config, backend, sessions, signal)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for update operations, safe/unsafe path validation, dry-run mode, and trigger gating, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Update Operations Preservation**: Verify that update operations are applied regardless of creation caps — run extraction with a mix of creates and updates, confirm all updates go through even when create cap is hit
2. **Validation Preservation**: Verify that unsafe paths, invalid frontmatter, and MEMORY.md targeting continue to be rejected identically
3. **Dry-Run Preservation**: Verify that dry-run mode still logs without writing, even with the new guardrails active
4. **Trigger Gating Preservation**: Verify that extraction is still skipped when no sessions are modified

### Unit Tests

- Test `maxMemoryFiles` enforcement: directory at cap → creates skipped, directory below cap → creates applied up to cap
- Test `maxPromptChars` enforcement: prompt truncation when manifest + sessions exceed budget
- Test `maxFilesPerBatch` enforcement: only N creates applied per pass
- Test per-session cursor: new sessions included, unchanged sessions excluded, appended sessions include only new content
- Test backward-compatible cursor migration from single-timestamp to per-session format
- Test config validation for new `maxMemoryFiles` field

### Property-Based Tests

- Generate random memory directory sizes (0–200 files) and random LLM responses (0–100 create ops) → verify post-extraction file count ≤ `maxMemoryFiles`
- Generate random manifest sizes and session content sizes → verify `buildExtractionPrompt` output ≤ `maxPromptChars`
- Generate random mixes of create/update/delete operations → verify creates capped at `maxFilesPerBatch` while updates and deletes are unaffected
- Generate random session cursor states and session file listings → verify only genuinely modified sessions are returned by `getUnprocessedSessions`

### Integration Tests

- Full extraction cycle with guardrails active: start with empty memory dir, run multiple extraction passes with a mock LLM that always tries to create 50 files, verify directory never exceeds `maxMemoryFiles`
- Prompt budget integration: set `maxPromptChars` to a small value, run extraction with many memory files and sessions, verify the LLM receives a prompt within budget
- Per-session cursor integration: run extraction, append to a session file, run again, verify only the new content is in the prompt
