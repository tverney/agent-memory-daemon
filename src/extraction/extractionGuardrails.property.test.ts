import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, writeFile, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExtraction } from './extractionEngine.js';
import { buildExtractionPrompt } from './extractionPromptBuilder.js';
import { evaluateExtractionTrigger } from './extractionTrigger.js';
import { writeExtractionCursor } from './cursorManager.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type { FileOperation, MemconsolidateConfig, MemoryType } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

/**
 * Bug Condition Exploration Tests
 *
 * These tests encode the EXPECTED behavior after the fix.
 * They MUST FAIL on unfixed code — failure confirms the bugs exist.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4
 */

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** Helper: create a valid memory file content string */
function makeMemoryContent(name: string, desc: string, type: MemoryType, body: string): string {
  return `---\nname: "${name}"\ndescription: "${desc}"\ntype: ${type}\n---\n${body}`;
}

/** Helper: build a config object with all required fields */
function makeConfig(overrides: Partial<MemconsolidateConfig> & { maxMemoryFiles?: number }): MemconsolidateConfig & { maxMemoryFiles?: number } {
  return {
    memoryDirectory: '',
    sessionDirectory: '',
    minHours: 24,
    minSessions: 5,
    staleLockThresholdMs: 3_600_000,
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    llmBackend: 'mock',
    llmBackendOptions: {},
    pollIntervalMs: 60_000,
    maxSessionContentChars: 2_000,
    maxMemoryContentChars: 4_000,
    dryRun: false,
    minConsolidationIntervalMs: 300_000,
    extractionEnabled: true,
    extractionIntervalMs: 60_000,
    maxExtractionSessionChars: 5_000,
    maxPromptChars: 60_000,
    maxFilesPerBatch: 30,
    ...overrides,
  };
}

describe('Bug Condition Exploration: Extraction Guardrails', () => {
  let tmpDir: string;
  let memoryDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `guardrail-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    memoryDir = join(tmpDir, 'memory');
    sessionDir = join(tmpDir, 'sessions');
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    // Create MEMORY.md index (required for readIndex)
    await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

    // Create a session file for extraction
    await writeFile(
      join(sessionDir, 'session-001.md'),
      '# Session\nUser discussed testing preferences and project architecture.',
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Test 1a — maxMemoryFiles cap
   *
   * **Validates: Requirements 2.1**
   *
   * Set up a memory directory with N existing .md files (N near maxMemoryFiles),
   * mock LLM returns C create operations where N + C > maxMemoryFiles.
   * Assert that post-extraction file count ≤ maxMemoryFiles.
   *
   * On unfixed code this FAILS because all C creates are applied without any cap.
   */
  it('Test 1a: file creation respects maxMemoryFiles cap', async () => {
    const MAX_MEMORY_FILES = 10;

    await fc.assert(
      fc.asyncProperty(
        // N: existing file count between 7 and 9 (near the cap)
        fc.integer({ min: 7, max: 9 }),
        // C: number of create operations that would exceed the cap
        fc.integer({ min: 3, max: 8 }),
        fc.constantFrom<MemoryType>(...MEMORY_TYPES),
        async (existingCount, createCount, memType) => {
          // Reset memory dir
          const files = await readdir(memoryDir);
          for (const f of files) {
            if (f !== 'MEMORY.md') await rm(join(memoryDir, f), { force: true });
          }
          await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

          // Create N existing memory files
          for (let i = 0; i < existingCount; i++) {
            const filename = `existing-mem-${i}.md`;
            await writeFile(
              join(memoryDir, filename),
              makeMemoryContent(`Existing ${i}`, `Existing memory ${i}`, memType, `Body ${i}`),
              'utf-8',
            );
          }

          // Generate C create operations that would push past the cap
          const createOps: FileOperation[] = [];
          for (let i = 0; i < createCount; i++) {
            createOps.push({
              op: 'create',
              path: `new-mem-${i}.md`,
              content: makeMemoryContent(`New ${i}`, `New memory ${i}`, memType, `New body ${i}`),
            });
          }

          const mockBackend: LlmBackend = {
            name: 'mock',
            initialize: async () => {},
            consolidate: async () => ({
              operations: createOps,
              reasoning: 'maxMemoryFiles cap test',
            }),
          };

          const config = makeConfig({
            memoryDirectory: memoryDir,
            sessionDirectory: sessionDir,
            maxMemoryFiles: MAX_MEMORY_FILES,
          });

          await runExtraction(
            config,
            mockBackend,
            ['session-001.md'],
            AbortSignal.timeout(10_000),
          );

          // Count .md files excluding MEMORY.md
          const allFiles = await readdir(memoryDir);
          const mdFiles = allFiles.filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

          // PROPERTY: post-extraction file count must not exceed maxMemoryFiles
          expect(mdFiles.length).toBeLessThanOrEqual(MAX_MEMORY_FILES);
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Test 1b — maxPromptChars budget
   *
   * **Validates: Requirements 2.2**
   *
   * Generate memory manifests and session content whose combined size exceeds
   * maxPromptChars. Call buildExtractionPrompt and assert prompt.length ≤ maxPromptChars.
   *
   * On unfixed code this FAILS because buildExtractionPrompt never checks total
   * prompt length against maxPromptChars — it only truncates individual sections.
   */
  it('Test 1b: prompt size respects maxPromptChars budget', async () => {
    const MAX_PROMPT_CHARS = 5_000;

    await fc.assert(
      fc.asyncProperty(
        // Number of memory files to create (enough to generate a large manifest)
        fc.integer({ min: 15, max: 30 }),
        // Number of session files
        fc.integer({ min: 3, max: 6 }),
        // Body size per memory file
        fc.integer({ min: 100, max: 300 }),
        // Session content size
        fc.integer({ min: 500, max: 1500 }),
        async (memFileCount, sessFileCount, bodySize, sessSize) => {
          // Create a fresh temp dir for this iteration
          const iterDir = join(tmpdir(), `prompt-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
          const iterMemDir = join(iterDir, 'memory');
          const iterSessDir = join(iterDir, 'sessions');
          await mkdir(iterMemDir, { recursive: true });
          await mkdir(iterSessDir, { recursive: true });

          try {
            // Create many memory files to inflate the manifest
            for (let i = 0; i < memFileCount; i++) {
              const body = 'x'.repeat(bodySize);
              await writeFile(
                join(iterMemDir, `mem-${i}.md`),
                makeMemoryContent(`Memory File ${i}`, `Description for memory ${i} with extra detail`, 'project', body),
                'utf-8',
              );
            }

            // Create session files with substantial content
            const sessionFilenames: string[] = [];
            for (let i = 0; i < sessFileCount; i++) {
              const filename = `session-${i}.md`;
              sessionFilenames.push(filename);
              const content = `# Session ${i}\n${'The user discussed various topics including architecture and preferences. '.repeat(Math.ceil(sessSize / 80))}`;
              await writeFile(join(iterSessDir, filename), content, 'utf-8');
            }

            const prompt = await buildExtractionPrompt(
              iterMemDir,
              sessionFilenames,
              iterSessDir,
              MAX_PROMPT_CHARS, // maxSessionChars — large enough to not truncate individually
              MAX_PROMPT_CHARS, // maxMemoryChars — large enough to not truncate individually
              MAX_PROMPT_CHARS, // maxPromptChars — the budget to enforce
            );

            // PROPERTY: prompt length must not exceed maxPromptChars
            expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
          } finally {
            await rm(iterDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  /**
   * Test 1c — maxFilesPerBatch per-pass cap
   *
   * **Validates: Requirements 2.3**
   *
   * Mock LLM returns C create operations where C > maxFilesPerBatch.
   * Assert result.filesCreated.length ≤ maxFilesPerBatch.
   *
   * On unfixed code this FAILS because all creates are applied.
   */
  it('Test 1c: per-pass creation respects maxFilesPerBatch', async () => {
    const MAX_FILES_PER_BATCH = 3;

    await fc.assert(
      fc.asyncProperty(
        // C: number of create operations exceeding the batch cap
        fc.integer({ min: MAX_FILES_PER_BATCH + 1, max: 12 }),
        fc.constantFrom<MemoryType>(...MEMORY_TYPES),
        async (createCount, memType) => {
          // Reset memory dir
          const files = await readdir(memoryDir);
          for (const f of files) {
            if (f !== 'MEMORY.md') await rm(join(memoryDir, f), { force: true });
          }
          await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

          // Generate C create operations
          const createOps: FileOperation[] = [];
          for (let i = 0; i < createCount; i++) {
            createOps.push({
              op: 'create',
              path: `batch-mem-${i}.md`,
              content: makeMemoryContent(`Batch ${i}`, `Batch memory ${i}`, memType, `Body ${i}`),
            });
          }

          const mockBackend: LlmBackend = {
            name: 'mock',
            initialize: async () => {},
            consolidate: async () => ({
              operations: createOps,
              reasoning: 'maxFilesPerBatch cap test',
            }),
          };

          const config = makeConfig({
            memoryDirectory: memoryDir,
            sessionDirectory: sessionDir,
            maxFilesPerBatch: MAX_FILES_PER_BATCH,
          });

          const result = await runExtraction(
            config,
            mockBackend,
            ['session-001.md'],
            AbortSignal.timeout(10_000),
          );

          // PROPERTY: files created in a single pass must not exceed maxFilesPerBatch
          expect(result.filesCreated.length).toBeLessThanOrEqual(MAX_FILES_PER_BATCH);
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Test 1d — Per-session cursor prevents reprocessing
   *
   * **Validates: Requirements 2.4**
   *
   * Process a session file, then call extraction trigger again without modifying
   * the session content (but after touching the file to update mtime).
   * Assert the session is excluded from the modified files list.
   *
   * On unfixed code this FAILS because the global-timestamp cursor re-includes
   * already-processed sessions when mtime is updated.
   */
  it('Test 1d: per-session cursor prevents reprocessing of already-extracted sessions', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Session content
        fc.stringMatching(/^[A-Za-z0-9 .,]{20,100}$/),
        async (sessionContent) => {
          // Create a fresh temp dir for this iteration
          const iterDir = join(tmpdir(), `cursor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
          const iterMemDir = join(iterDir, 'memory');
          const iterSessDir = join(iterDir, 'sessions');
          await mkdir(iterMemDir, { recursive: true });
          await mkdir(iterSessDir, { recursive: true });

          try {
            await writeFile(join(iterMemDir, 'MEMORY.md'), '', 'utf-8');

            // Write a session file
            const sessionFile = 'session-test.md';
            await writeFile(
              join(iterSessDir, sessionFile),
              `# Session\n${sessionContent}`,
              'utf-8',
            );

            // Simulate first extraction: write cursor at current time
            // (this is what happens after a successful extraction pass)
            const cursorTime = Date.now();
            await writeExtractionCursor(iterMemDir, cursorTime);

            // Wait a small amount then touch the file to update mtime
            // without changing content (simulates the bug scenario)
            await new Promise(resolve => setTimeout(resolve, 50));
            const futureTime = new Date(cursorTime + 1000);
            await utimes(join(iterSessDir, sessionFile), futureTime, futureTime);

            // Call extraction trigger — on unfixed code, the session will be
            // re-included because its mtime > cursorTimestamp, even though
            // content hasn't changed
            const triggerResult = await evaluateExtractionTrigger(iterSessDir, cursorTime);

            // PROPERTY: already-processed session should NOT be in modified files
            // The session content hasn't changed, only mtime was updated.
            // A per-session cursor would track that this session was already processed.
            expect(triggerResult.modifiedFiles).not.toContain(sessionFile);
          } finally {
            await rm(iterDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});
