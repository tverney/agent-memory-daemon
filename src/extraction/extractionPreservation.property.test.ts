import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExtraction } from './extractionEngine.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type { FileOperation, MemconsolidateConfig, MemoryType } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

/**
 * Preservation Property Tests
 *
 * These tests capture EXISTING behavior on UNFIXED code.
 * They MUST PASS on unfixed code — passing confirms the baseline behavior
 * that must be preserved after the fix is applied.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** Helper: create valid memory file content */
function makeMemoryContent(name: string, desc: string, type: MemoryType, body: string): string {
  return `---\nname: "${name}"\ndescription: "${desc}"\ntype: ${type}\n---\n${body}`;
}

/** Helper: build a config object with all required fields */
function makeConfig(overrides: Partial<MemconsolidateConfig> = {}): MemconsolidateConfig {
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

describe('Preservation Property Tests: Existing Extraction Behavior Unchanged', () => {
  let tmpDir: string;
  let memoryDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `preserve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
   * Test 2a — Update operations unaffected by creation caps
   *
   * **Validates: Requirements 3.2**
   *
   * Generate a mix of create and update operations via fast-check.
   * Run extraction with a low maxFilesPerBatch.
   * Assert all valid update operations are applied even when create ops exist.
   *
   * On UNFIXED code: there are no creation caps, so ALL creates AND ALL updates
   * are applied. The property we preserve is that update operations are always
   * applied regardless of how many create operations exist.
   */
  it('Test 2a: update operations are applied regardless of create operations', async () => {
    // Arbitraries for generating valid filenames and content
    const filenameArb = fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{2,12}$/)
      .filter((n) => `${n}.md` !== 'MEMORY.md');
    const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{1,15}$/);
    const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
    const bodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?]{1,50}$/);
    const memTypeArb = fc.constantFrom<MemoryType>(...MEMORY_TYPES);

    // Generate 1-3 update operations and 1-4 create operations
    const updateOpArb = fc
      .tuple(filenameArb, nameArb, descArb, memTypeArb, bodyArb)
      .map(([fn, name, desc, type, body]): FileOperation => ({
        op: 'update',
        path: `upd-${fn}.md`,
        content: makeMemoryContent(name, desc, type, body),
      }));

    const createOpArb = fc
      .tuple(filenameArb, nameArb, descArb, memTypeArb, bodyArb)
      .map(([fn, name, desc, type, body]): FileOperation => ({
        op: 'create',
        path: `crt-${fn}.md`,
        content: makeMemoryContent(name, desc, type, body),
      }));

    const opsArb = fc
      .tuple(
        fc.array(updateOpArb, { minLength: 1, maxLength: 3 }),
        fc.array(createOpArb, { minLength: 1, maxLength: 4 }),
      )
      .map(([updates, creates]) => {
        // Deduplicate by path
        const seen = new Set<string>();
        const deduped: FileOperation[] = [];
        for (const op of [...updates, ...creates]) {
          if (!seen.has(op.path)) {
            seen.add(op.path);
            deduped.push(op);
          }
        }
        return deduped;
      })
      .filter((ops) => ops.some((o) => o.op === 'update') && ops.some((o) => o.op === 'create'));

    await fc.assert(
      fc.asyncProperty(opsArb, async (operations) => {
        // Reset memory dir
        const files = await readdir(memoryDir);
        for (const f of files) {
          if (f !== 'MEMORY.md') await rm(join(memoryDir, f), { force: true });
        }
        await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

        // Pre-create files that update operations will target
        const updateOps = operations.filter((o) => o.op === 'update');
        for (const op of updateOps) {
          await writeFile(
            join(memoryDir, op.path),
            makeMemoryContent('Placeholder', 'Placeholder desc', 'project', 'Old body'),
            'utf-8',
          );
        }

        const mockBackend: LlmBackend = {
          name: 'mock',
          initialize: async () => {},
          consolidate: async () => ({
            operations,
            reasoning: 'preservation test 2a',
          }),
        };

        const config = makeConfig({
          memoryDirectory: memoryDir,
          sessionDirectory: sessionDir,
          maxFilesPerBatch: 3, // Low cap — but on unfixed code this is ignored for extraction
        });

        const result = await runExtraction(
          config,
          mockBackend,
          ['session-001.md'],
          AbortSignal.timeout(10_000),
        );

        // PROPERTY: for all valid update ops, result.filesUpdated includes the update path
        for (const op of updateOps) {
          expect(result.filesUpdated).toContain(op.path);
        }
      }),
      { numRuns: 30 },
    );
  });

  /**
   * Test 2b — Validation and filtering unchanged
   *
   * **Validates: Requirements 3.3, 3.4**
   *
   * Generate operations with unsafe paths, missing frontmatter, and MEMORY.md
   * targeting via fast-check. Assert they are all skipped with the same behavior
   * as before.
   *
   * Property: for all invalid ops, operationsSkipped increments and no files
   * are written for those operations.
   */
  it('Test 2b: invalid operations are skipped and no files are written', async () => {
    // Generate a mix of invalid operations
    const unsafePathArb = fc.constantFrom<FileOperation>(
      { op: 'create', path: '../escape.md', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
      { op: 'create', path: 'sub/dir.md', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
      { op: 'create', path: '/absolute.md', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
      { op: 'create', path: 'back\\slash.md', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
      { op: 'create', path: 'no-extension', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
      { op: 'create', path: 'file.txt', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
      { op: 'create', path: '%2e%2e/encoded.md', content: makeMemoryContent('Bad', 'bad', 'user', 'body') },
    );

    const memoryMdOpArb = fc.constant<FileOperation>({
      op: 'update',
      path: 'MEMORY.md',
      content: makeMemoryContent('Index', 'index', 'user', 'body'),
    });

    const missingFrontmatterArb = fc.constantFrom<FileOperation>(
      { op: 'create', path: 'valid-path.md', content: 'no frontmatter here' },
      { op: 'create', path: 'another-valid.md', content: '---\ndescription: "no name"\ntype: user\n---\nbody' },
      { op: 'update', path: 'update-no-fm.md', content: 'just plain text' },
    );

    const invalidOpsArb = fc
      .tuple(
        fc.array(unsafePathArb, { minLength: 1, maxLength: 3 }),
        fc.array(memoryMdOpArb, { minLength: 0, maxLength: 1 }),
        fc.array(missingFrontmatterArb, { minLength: 1, maxLength: 2 }),
      )
      .map(([unsafe, memMd, noFm]) => [...unsafe, ...memMd, ...noFm]);

    await fc.assert(
      fc.asyncProperty(invalidOpsArb, async (operations) => {
        // Reset memory dir
        const files = await readdir(memoryDir);
        for (const f of files) {
          if (f !== 'MEMORY.md') await rm(join(memoryDir, f), { force: true });
        }
        await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

        // Snapshot files before extraction
        const filesBefore = new Set(await readdir(memoryDir));

        const mockBackend: LlmBackend = {
          name: 'mock',
          initialize: async () => {},
          consolidate: async () => ({
            operations,
            reasoning: 'preservation test 2b',
          }),
        };

        const config = makeConfig({
          memoryDirectory: memoryDir,
          sessionDirectory: sessionDir,
        });

        const result = await runExtraction(
          config,
          mockBackend,
          ['session-001.md'],
          AbortSignal.timeout(10_000),
        );

        // Count how many ops are NOT MEMORY.md (those are filtered before validation)
        const nonMemoryOps = operations.filter((o) => o.path !== 'MEMORY.md');

        // PROPERTY: all non-MEMORY.md invalid ops are skipped
        expect(result.operationsSkipped).toBe(nonMemoryOps.length);
        expect(result.operationsApplied).toBe(0);

        // PROPERTY: no new files are written for invalid operations
        const filesAfter = new Set(await readdir(memoryDir));
        expect(filesAfter).toEqual(filesBefore);
      }),
      { numRuns: 30 },
    );
  });

  /**
   * Test 2c — Dry-run preservation
   *
   * **Validates: Requirements 3.1, 3.5, 3.6**
   *
   * Generate valid create/update operations, run extraction with dryRun: true.
   * Assert no files are created or modified on disk.
   *
   * Property: for all ops under dryRun, filesystem is unchanged.
   */
  it('Test 2c: dry-run mode logs operations without writing to disk', async () => {
    const filenameArb = fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{2,12}$/)
      .filter((n) => `${n}.md` !== 'MEMORY.md');
    const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{1,15}$/);
    const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
    const bodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?]{1,50}$/);
    const memTypeArb = fc.constantFrom<MemoryType>(...MEMORY_TYPES);
    const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');

    const fileOpArb = fc
      .tuple(opTypeArb, filenameArb, nameArb, descArb, memTypeArb, bodyArb)
      .map(([op, fn, name, desc, type, body]): FileOperation => ({
        op,
        path: `dry-${fn}.md`,
        content: makeMemoryContent(name, desc, type, body),
      }));

    const opsArb = fc
      .array(fileOpArb, { minLength: 1, maxLength: 5 })
      .map((ops) => {
        // Deduplicate by path
        const seen = new Set<string>();
        return ops.filter((op) => {
          if (seen.has(op.path)) return false;
          seen.add(op.path);
          return true;
        });
      })
      .filter((ops) => ops.length > 0);

    await fc.assert(
      fc.asyncProperty(opsArb, async (operations) => {
        // Reset memory dir
        const files = await readdir(memoryDir);
        for (const f of files) {
          if (f !== 'MEMORY.md') await rm(join(memoryDir, f), { force: true });
        }
        await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

        // Pre-create files for update operations
        for (const op of operations) {
          if (op.op === 'update') {
            await writeFile(
              join(memoryDir, op.path),
              makeMemoryContent('Placeholder', 'Placeholder', 'project', 'Old'),
              'utf-8',
            );
          }
        }

        // Snapshot filesystem state
        const filesBefore = new Set(await readdir(memoryDir));
        const contentsBefore = new Map<string, string>();
        for (const f of filesBefore) {
          contentsBefore.set(f, await readFile(join(memoryDir, f), 'utf-8'));
        }

        const mockBackend: LlmBackend = {
          name: 'mock',
          initialize: async () => {},
          consolidate: async () => ({
            operations,
            reasoning: 'preservation test 2c',
          }),
        };

        const config = makeConfig({
          memoryDirectory: memoryDir,
          sessionDirectory: sessionDir,
          dryRun: true,
        });

        const result = await runExtraction(
          config,
          mockBackend,
          ['session-001.md'],
          AbortSignal.timeout(10_000),
        );

        // Verify operations were counted as applied (dry-run still counts them)
        expect(result.operationsApplied).toBe(operations.length);

        // PROPERTY: filesystem is unchanged after dry-run
        const filesAfter = new Set(await readdir(memoryDir));
        expect(filesAfter).toEqual(filesBefore);

        // Verify file contents are unchanged
        for (const [filename, contentBefore] of contentsBefore) {
          const contentAfter = await readFile(join(memoryDir, filename), 'utf-8');
          expect(contentAfter).toBe(contentBefore);
        }
      }),
      { numRuns: 30 },
    );
  });
});
