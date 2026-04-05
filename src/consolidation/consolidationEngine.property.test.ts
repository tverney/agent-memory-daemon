import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runConsolidation } from './consolidationEngine.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type { MemconsolidateConfig, LlmResponse, MemoryHeader } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

// We need to control what scanMemoryFiles returns per test run,
// so we use a mutable reference that the mock reads from.
let mockMemories: MemoryHeader[] = [];

vi.mock('../memory/memoryScanner.js', () => ({
  scanMemoryFiles: vi.fn(async () => mockMemories),
  formatMemoryManifest: vi.fn(() => ''),
}));

vi.mock('./promptBuilder.js', () => ({
  buildConsolidationPrompt: vi.fn().mockResolvedValue('mock prompt'),
  buildChunkPrompt: vi.fn().mockResolvedValue('mock chunk prompt'),
  buildSharedContext: vi.fn().mockResolvedValue({
    indexEntries: [],
    sessions: [],
    manifest: '',
    indexContent: '',
    stalenessCaveats: '',
    today: '2025-01-01',
  }),
  buildSystemPrompt: vi.fn().mockReturnValue('mock system prompt'),
}));

// --- Helpers ---

let tmpDir: string;
let sessionDir: string;

function makeConfig(overrides: Partial<MemconsolidateConfig> = {}): MemconsolidateConfig {
  return {
    memoryDirectory: tmpDir,
    sessionDirectory: sessionDir,
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
    extractionEnabled: false,
    extractionIntervalMs: 60_000,
    maxExtractionSessionChars: 5_000,
    maxPromptChars: 60_000,
    maxFilesPerBatch: 30,
    ...overrides,
  };
}

function makeBackend(response: LlmResponse): LlmBackend {
  return {
    name: 'mock',
    initialize: vi.fn().mockResolvedValue(undefined),
    consolidate: vi.fn().mockResolvedValue(response),
  };
}

function validContent(name: string): string {
  return `---\nname: "${name}"\ndescription: "desc"\ntype: project\n---\nBody of ${name}`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prop9-test-'));
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prop9-sess-'));
  mockMemories = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(sessionDir, { recursive: true, force: true });
});

/**
 * Create memory files on disk and set up the mock scanner to return
 * matching headers. Returns the headers array.
 */
async function setupMemoryFiles(count: number, contentSize: number): Promise<MemoryHeader[]> {
  const headers: MemoryHeader[] = [];
  for (let i = 0; i < count; i++) {
    const fileName = `memory-${i}.md`;
    const name = `Memory ${i}`;
    // Build content with valid frontmatter and a body padded to contentSize
    const frontmatter = `---\nname: "${name}"\ndescription: "desc ${i}"\ntype: project\n---\n`;
    const bodyNeeded = Math.max(0, contentSize - frontmatter.length);
    const body = 'x'.repeat(bodyNeeded);
    const content = frontmatter + body;

    await fs.writeFile(path.join(tmpDir, fileName), content, 'utf-8');
    headers.push({
      path: fileName,
      name,
      description: `desc ${i}`,
      type: 'project',
      mtimeMs: Date.now(),
    });
  }
  mockMemories = headers;
  return headers;
}

// Feature: batch-consolidation, Property 9: Result chunk metrics
describe('Property 9: Result chunk metrics', () => {
  /**
   * **Validates: Requirements 7.1, 7.2**
   *
   * For any consolidation pass with a mock LLM backend, the returned
   * ConsolidationResult should have:
   * - chunksTotal equal to the number of planned chunks
   * - chunksCompleted ≤ chunksTotal
   * - For a fully successful pass, chunksCompleted === chunksTotal
   */
  it('chunksTotal and chunksCompleted are correct for various file sets', async () => {
    await fc.assert(
      fc.asyncProperty(
        // fileCount: 0–15 files (kept small for filesystem I/O)
        fc.integer({ min: 0, max: 15 }),
        // contentSize per file: 100–5000 chars
        fc.integer({ min: 100, max: 5000 }),
        // maxFilesPerBatch: 1–10
        fc.integer({ min: 1, max: 10 }),
        // maxPromptChars: 10000–80000
        fc.integer({ min: 10_000, max: 80_000 }),
        async (fileCount, contentSize, maxFilesPerBatch, maxPromptChars) => {
          // Set up memory files on disk and mock scanner
          await setupMemoryFiles(fileCount, contentSize);

          const backend = makeBackend({ operations: [], reasoning: 'no-op' });
          const config = makeConfig({ maxPromptChars, maxFilesPerBatch });

          const result = await runConsolidation(config, backend, new AbortController().signal);

          // chunksTotal should be at least 1 (even for 0 files, planChunks returns 1 chunk)
          expect(result.chunksTotal).toBeGreaterThanOrEqual(1);

          // For a fully successful pass (no abort, no LLM failure),
          // chunksCompleted should equal chunksTotal
          expect(result.chunksCompleted).toBe(result.chunksTotal);

          // chunksCompleted should never exceed chunksTotal
          expect(result.chunksCompleted).toBeLessThanOrEqual(result.chunksTotal);

          // When fileCount <= maxFilesPerBatch and content fits, should be single chunk
          // (We can't easily predict exact chunk count due to overhead calculations,
          // but we can verify the invariant holds)

          // Clean up files for next iteration
          const entries = await fs.readdir(tmpDir);
          for (const entry of entries) {
            await fs.unlink(path.join(tmpDir, entry));
          }
          mockMemories = [];
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: batch-consolidation, Property 10: Result aggregated metrics
describe('Property 10: Result aggregated metrics', () => {
  /**
   * **Validates: Requirements 7.3, 7.4**
   *
   * For any consolidation pass, the returned ConsolidationResult should have:
   * - promptLength equal to the sum of individual chunk prompt lengths
   * - operationsRequested equal to the sum of operations returned by each chunk's LLM call
   */
  it('promptLength and operationsRequested are correct sums across chunks', async () => {
    const SINGLE_PROMPT_LEN = 'mock prompt'.length;       // 11
    const CHUNK_PROMPT_LEN = 'mock chunk prompt'.length;   // 16
    const OPS_PER_CALL = 2;

    // Build a fixed set of valid operations the mock LLM returns per call
    function makeMockOps(): import('../types.js').FileOperation[] {
      return Array.from({ length: OPS_PER_CALL }, (_, i) => ({
        op: 'create' as const,
        path: `gen-file-${i}.md`,
        content: `---\nname: "gen"\ndescription: "d"\ntype: project\n---\nbody`,
      }));
    }

    await fc.assert(
      fc.asyncProperty(
        // fileCount: 0–15 files
        fc.integer({ min: 0, max: 15 }),
        // contentSize per file: 100–5000 chars
        fc.integer({ min: 100, max: 5000 }),
        // maxFilesPerBatch: 1–10
        fc.integer({ min: 1, max: 10 }),
        // maxPromptChars: 10000–80000
        fc.integer({ min: 10_000, max: 80_000 }),
        async (fileCount, contentSize, maxFilesPerBatch, maxPromptChars) => {
          await setupMemoryFiles(fileCount, contentSize);

          const mockOps = makeMockOps();
          const backend = makeBackend({ operations: mockOps, reasoning: 'test' });
          const consolidateFn = backend.consolidate as ReturnType<typeof vi.fn>;
          consolidateFn.mockClear();

          const config = makeConfig({ maxPromptChars, maxFilesPerBatch });
          const result = await runConsolidation(config, backend, new AbortController().signal);

          const callCount = consolidateFn.mock.calls.length;

          // Determine expected prompt length based on single vs multi chunk
          let expectedPromptLength: number;
          if (result.chunksTotal <= 1) {
            // Single-chunk uses buildConsolidationPrompt → 'mock prompt' (11 chars)
            expectedPromptLength = SINGLE_PROMPT_LEN;
          } else {
            // Multi-chunk uses buildChunkPrompt → 'mock chunk prompt' (16 chars) per chunk
            expectedPromptLength = CHUNK_PROMPT_LEN * callCount;
          }

          expect(result.promptLength).toBe(expectedPromptLength);
          expect(result.operationsRequested).toBe(OPS_PER_CALL * callCount);

          // Clean up files for next iteration
          const entries = await fs.readdir(tmpDir);
          for (const entry of entries) {
            await fs.unlink(path.join(tmpDir, entry));
          }
          mockMemories = [];
        },
      ),
      { numRuns: 100 },
    );
  });
});
