# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Unbounded File Creation and Prompt Size
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the four missing guardrails
  - **Scoped PBT Approach**: Use fast-check to generate extraction scenarios that trigger each guardrail gap
  - Create test file `src/extraction/extractionGuardrails.property.test.ts`
  - Test 1a — maxMemoryFiles cap: Set up a memory directory with N existing `.md` files (N near `maxMemoryFiles`), mock LLM returns C create operations where `N + C > maxMemoryFiles`. Assert that post-extraction file count ≤ `maxMemoryFiles`. On unfixed code this will FAIL because all C creates are applied.
  - Test 1b — maxPromptChars budget: Generate memory manifests and session content whose combined size exceeds `maxPromptChars`. Call `buildExtractionPrompt` and assert `prompt.length ≤ maxPromptChars`. On unfixed code this will FAIL because prompt is assembled without budget enforcement.
  - Test 1c — maxFilesPerBatch per-pass cap: Mock LLM returns C create operations where `C > maxFilesPerBatch`. Assert `result.filesCreated.length ≤ maxFilesPerBatch`. On unfixed code this will FAIL because all creates are applied.
  - Test 1d — Per-session cursor prevents reprocessing: Process a session file, then call extraction again without modifying the session. Assert the session is excluded from the modified files list. On unfixed code this will FAIL because the global-timestamp cursor re-includes already-processed sessions when mtime is updated.
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — it proves the bugs exist)
  - Document counterexamples found to understand root cause
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Existing Extraction Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Create test file `src/extraction/extractionPreservation.property.test.ts`
  - Observe on UNFIXED code: update operations are applied regardless of how many create operations exist
  - Observe on UNFIXED code: operations with unsafe paths (`../escape.md`, `MEMORY.md`, paths without `.md`) are rejected
  - Observe on UNFIXED code: operations with invalid frontmatter (missing `name` field) are rejected
  - Observe on UNFIXED code: dry-run mode logs operations without writing to disk
  - Test 2a — Update operations unaffected by creation caps: Generate a mix of create and update operations via fast-check. Run extraction with a low `maxFilesPerBatch`. Assert all valid update operations are applied even when create cap is hit. Property: `for all valid update ops, result.filesUpdated includes the update path`.
  - Test 2b — Validation and filtering unchanged: Generate operations with unsafe paths, missing frontmatter, and MEMORY.md targeting via fast-check. Assert they are all skipped with the same behavior as before. Property: `for all invalid ops, operationsSkipped increments and no files are written`.
  - Test 2c — Dry-run preservation: Generate valid create/update operations, run extraction with `dryRun: true`. Assert no files are created or modified on disk. Property: `for all ops under dryRun, filesystem is unchanged`.
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [-] 3. Implement extraction guardrails fix

  - [x] 3.1 Add `maxMemoryFiles` config field and `SessionCursor` type to `src/types.ts`
    - Add `maxMemoryFiles: number` to `MemconsolidateConfig` interface
    - Add `SessionCursor` type: `Record<string, { offset: number; mtimeMs: number }>`
    - _Bug_Condition: isBugCondition(state, llmResponse) where system does NOT enforce maxMemoryFiles AND cursorType == 'global-timestamp-only'_
    - _Expected_Behavior: Config includes maxMemoryFiles field; cursor tracks per-session offsets_
    - _Preservation: Existing type definitions unchanged_
    - _Requirements: 2.1, 2.4_

  - [x] 3.2 Add `maxMemoryFiles` default, validation, and TOML key mapping to `src/config.ts`
    - Add `maxMemoryFiles: 100` to DEFAULTS
    - Add `max_memory_files: 'maxMemoryFiles'` to KEY_MAP
    - Add `maxMemoryFiles` to `validateConfig` with constraint `≥ 1`
    - _Bug_Condition: No maxMemoryFiles config field exists to enforce_
    - _Expected_Behavior: validateConfig produces config with maxMemoryFiles defaulting to 100, rejects values < 1_
    - _Preservation: All existing config fields and validation unchanged_
    - _Requirements: 2.1_

  - [x] 3.3 Enforce `maxMemoryFiles` cap and `maxFilesPerBatch` cap on create operations in `src/extraction/extractionEngine.ts`
    - Before the operation loop, count existing `.md` files in memory directory (excluding `MEMORY.md`)
    - Track a `createdCount` counter in the operation loop
    - Before applying each `create` operation, check: `existingFileCount + createdCount < config.maxMemoryFiles` AND `createdCount < config.maxFilesPerBatch`
    - If either cap is reached, skip the create operation, increment `operationsSkipped`, and log a warning
    - Update and delete operations are NOT subject to these caps
    - _Bug_Condition: existingFileCount + createOps.length > maxMemoryFiles AND system does NOT enforce; createOps.length > maxFilesPerBatch AND system does NOT cap_
    - _Expected_Behavior: At most max(0, maxMemoryFiles - existingCount) creates applied; at most maxFilesPerBatch creates per pass_
    - _Preservation: Update and delete operations continue to be applied normally_
    - _Requirements: 2.1, 2.3, 3.2_

  - [x] 3.4 Enforce `maxPromptChars` budget in `src/extraction/extractionPromptBuilder.ts`
    - Add `maxPromptChars` parameter to `buildExtractionPrompt` function signature
    - After assembling all sections, check total prompt length against `maxPromptChars`
    - If over budget, progressively truncate: first trim session blocks (from the end), then trim manifest section
    - Ensure the returned prompt length ≤ `maxPromptChars`
    - Update the call site in `extractionEngine.ts` to pass `config.maxPromptChars`
    - _Bug_Condition: promptLength > config.maxPromptChars AND system does NOT truncate_
    - _Expected_Behavior: buildExtractionPrompt output.length ≤ maxPromptChars for all inputs_
    - _Preservation: Prompts that already fit within budget are returned unchanged_
    - _Requirements: 2.2_

  - [x] 3.5 Replace single-timestamp cursor with per-session cursor tracking in `src/extraction/cursorManager.ts`
    - Add `SessionCursor` import from types
    - Add `readSessionCursor(memoryDir)` function: reads JSON cursor file, returns `SessionCursor` map. If file contains a plain number (legacy), return empty map (treat as fresh start).
    - Add `writeSessionCursor(memoryDir, cursor: SessionCursor)` function: writes JSON cursor file
    - Add `getUnprocessedSessions(sessionDir, cursor: SessionCursor)` function: scans session directory, returns only sessions that are new (not in cursor) or modified (mtime changed since cursor entry)
    - Maintain backward compatibility: if cursor file contains a plain number, migrate gracefully
    - Update daemon.ts to use new cursor functions for extraction path
    - _Bug_Condition: cursorType == 'global-timestamp-only' AND sessionFiles includes already-processed content_
    - _Expected_Behavior: Only genuinely new/modified sessions are included in extraction_
    - _Preservation: Existing readExtractionCursor/writeExtractionCursor still work for consolidation trigger_
    - _Requirements: 2.4, 3.5, 3.6_

  - [x] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Unbounded File Creation and Prompt Size
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Existing Extraction Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npx vitest --run`
  - Ensure all existing tests (extractionEngine.test.ts, extractionConfig.test.ts, etc.) still pass
  - Ensure new guardrail property tests pass
  - Ensure new preservation property tests pass
  - Ask the user if questions arise
