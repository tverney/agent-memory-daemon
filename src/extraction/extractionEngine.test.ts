import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateOperationPath,
  validateFileContent,
  applyOperation,
} from '../consolidation/consolidationEngine.js';
import { runExtraction } from './extractionEngine.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type { FileOperation, MemconsolidateConfig, MemoryType } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

describe('Extraction engine property tests', () => {
  // Feature: memory-extraction, Property 9: Validation rejects unsafe paths and invalid frontmatter
  // Validates: Requirements 6.2, 6.3

  describe('Property 9: validateOperationPath rejects unsafe paths', () => {
    it('rejects paths containing traversal sequences (..)', () => {
      const traversalArb = fc
        .tuple(
          fc.stringMatching(/^[a-z]{0,5}$/),
          fc.stringMatching(/^[a-z]{1,10}\.md$/),
        )
        .map(([prefix, suffix]) => `${prefix}../${suffix}`);

      fc.assert(
        fc.property(traversalArb, (unsafePath) => {
          expect(validateOperationPath(unsafePath)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects absolute paths', () => {
      const absoluteArb = fc
        .stringMatching(/^[a-z]{1,15}\.md$/)
        .map((name) => `/${name}`);

      fc.assert(
        fc.property(absoluteArb, (absPath) => {
          expect(validateOperationPath(absPath)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects paths not ending in .md', () => {
      const nonMdExtArb = fc.constantFrom('.txt', '.json', '.yaml', '.js', '.ts', '.html', '');
      const nameArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
      const nonMdArb = fc.tuple(nameArb, nonMdExtArb).map(([n, ext]) => `${n}${ext}`);

      fc.assert(
        fc.property(nonMdArb, (nonMdPath) => {
          expect(validateOperationPath(nonMdPath)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects MEMORY.md (the index file)', () => {
      expect(validateOperationPath('MEMORY.md')).toBe(false);
    });

    it('rejects paths containing slashes (subdirectory traversal)', () => {
      const slashPathArb = fc
        .tuple(
          fc.stringMatching(/^[a-z]{1,10}$/),
          fc.stringMatching(/^[a-z]{1,10}\.md$/),
        )
        .map(([dir, file]) => `${dir}/${file}`);

      fc.assert(
        fc.property(slashPathArb, (slashPath) => {
          expect(validateOperationPath(slashPath)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects paths containing backslashes', () => {
      const backslashArb = fc
        .tuple(
          fc.stringMatching(/^[a-z]{1,10}$/),
          fc.stringMatching(/^[a-z]{1,10}\.md$/),
        )
        .map(([dir, file]) => `${dir}\\${file}`);

      fc.assert(
        fc.property(backslashArb, (bsPath) => {
          expect(validateOperationPath(bsPath)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects empty or whitespace-only paths', () => {
      const emptyArb = fc.constantFrom('', ' ', '  ', '\t', '\n');

      fc.assert(
        fc.property(emptyArb, (emptyPath) => {
          expect(validateOperationPath(emptyPath)).toBe(false);
        }),
      );
    });

    it('rejects paths with URL-encoded traversal sequences', () => {
      const encodedArb = fc.constantFrom(
        '%2e%2e/file.md',
        '%2E%2E/file.md',
        'foo%2fbar.md',
        'foo%2Fbar.md',
        'foo%5cbar.md',
        'foo%5Cbar.md',
      );

      fc.assert(
        fc.property(encodedArb, (encoded) => {
          expect(validateOperationPath(encoded)).toBe(false);
        }),
      );
    });

    it('accepts valid flat .md filenames (not MEMORY.md)', () => {
      const validArb = fc
        .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/)
        .filter((n) => `${n}.md` !== 'MEMORY.md')
        .map((n) => `${n}.md`);

      fc.assert(
        fc.property(validArb, (validPath) => {
          expect(validateOperationPath(validPath)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 9: validateFileContent rejects invalid frontmatter', () => {
    it('rejects create/update ops with no content', () => {
      const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');

      fc.assert(
        fc.property(opTypeArb, (opType) => {
          const op: FileOperation = {
            op: opType,
            path: 'test.md',
          };
          expect(validateFileContent(op)).toBe(false);
        }),
      );
    });

    it('rejects create/update ops with content missing frontmatter block', () => {
      const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');
      const bodyArb = fc
        .string({ minLength: 1, maxLength: 200 })
        .filter((s) => !s.startsWith('---'));

      fc.assert(
        fc.property(opTypeArb, bodyArb, (opType, body) => {
          const op: FileOperation = {
            op: opType,
            path: 'test.md',
            content: body,
          };
          expect(validateFileContent(op)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects create/update ops with frontmatter missing name field', () => {
      const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');
      const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/);

      fc.assert(
        fc.property(opTypeArb, descArb, (opType, desc) => {
          const content = `---\ndescription: "${desc}"\ntype: project\n---\nBody`;
          const op: FileOperation = {
            op: opType,
            path: 'test.md',
            content,
          };
          expect(validateFileContent(op)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('accepts delete ops without content validation', () => {
      const op: FileOperation = {
        op: 'delete',
        path: 'test.md',
      };
      expect(validateFileContent(op)).toBe(true);
    });

    it('accepts create/update ops with valid frontmatter including name', () => {
      const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');
      const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,20}$/);
      const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/);

      fc.assert(
        fc.property(opTypeArb, nameArb, descArb, (opType, name, desc) => {
          const content = `---\nname: "${name}"\ndescription: "${desc}"\ntype: project\n---\nBody content`;
          const op: FileOperation = {
            op: opType,
            path: 'test.md',
            content,
          };
          expect(validateFileContent(op)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

// Feature: memory-extraction, Property 10: Valid file operations are applied to disk
describe('Property 10: Valid file operations are applied to disk', () => {
  // Validates: Requirements 6.4, 6.5
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fileop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create/update operations write content that can be read back identically', async () => {
    const memoryTypeArb = fc.constantFrom<MemoryType>('user', 'feedback', 'project', 'reference');
    const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');
    const filenameArb = fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/)
      .filter((n) => `${n}.md` !== 'MEMORY.md')
      .map((n) => `${n}.md`);
    const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,20}$/);
    const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/);
    const bodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?\n]{0,200}$/);

    const fileOpArb = fc
      .tuple(opTypeArb, filenameArb, nameArb, descArb, memoryTypeArb, bodyArb)
      .map(([op, filename, name, desc, type, body]) => {
        const content = `---\nname: "${name}"\ndescription: "${desc}"\ntype: ${type}\n---\n${body}`;
        return { op, path: filename, content } as FileOperation;
      });

    await fc.assert(
      fc.asyncProperty(fileOpArb, async (op) => {
        // For 'update' ops, the file must already exist
        if (op.op === 'update') {
          await writeFile(join(tmpDir, op.path), 'placeholder', 'utf-8');
        }

        await applyOperation(tmpDir, op);

        const readBack = await readFile(join(tmpDir, op.path), 'utf-8');
        expect(readBack).toBe(op.content);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-extraction, Property 11: Dry run produces no file writes
describe('Property 11: Dry run produces no file writes', () => {
  // Validates: Requirements 6.6
  let tmpDir: string;
  let memoryDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dryrun-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    memoryDir = join(tmpDir, 'memory');
    sessionDir = join(tmpDir, 'sessions');
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    // Create an empty MEMORY.md index so readIndex works
    await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

    // Create a session file so buildExtractionPrompt can read it
    await writeFile(
      join(sessionDir, 'session-001.md'),
      '# Session\nUser discussed testing preferences.',
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('no files are created or modified on disk when dryRun is true', async () => {
    const memoryTypeArb = fc.constantFrom<MemoryType>('user', 'feedback', 'project', 'reference');
    const opTypeArb = fc.constantFrom<'create' | 'update'>('create', 'update');
    const filenameArb = fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/)
      .filter((n) => `${n}.md` !== 'MEMORY.md')
      .map((n) => `${n}.md`);
    const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,15}$/);
    const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
    const bodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?]{0,50}$/);

    const fileOpArb = fc
      .tuple(opTypeArb, filenameArb, nameArb, descArb, memoryTypeArb, bodyArb)
      .map(([op, filename, name, desc, type, body]) => {
        const content = `---\nname: "${name}"\ndescription: "${desc}"\ntype: ${type}\n---\n${body}`;
        return { op, path: filename, content } as FileOperation;
      });

    // Generate 1-5 operations per run
    const opsArb = fc.array(fileOpArb, { minLength: 1, maxLength: 5 });

    await fc.assert(
      fc.asyncProperty(opsArb, async (operations) => {
        // Snapshot files before extraction
        const filesBefore = new Set(await readdir(memoryDir));
        const indexBefore = await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8');

        // Mock LLM backend to return the generated operations
        const mockBackend: LlmBackend = {
          name: 'mock',
          initialize: async () => {},
          consolidate: async () => ({
            operations,
            reasoning: 'dry run test',
          }),
        };

        const config: MemconsolidateConfig = {
          memoryDirectory: memoryDir,
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
          dryRun: true,
          minConsolidationIntervalMs: 300_000,
          extractionEnabled: true,
          extractionIntervalMs: 60_000,
          maxExtractionSessionChars: 5_000,
        };

        const result = await runExtraction(
          config,
          mockBackend,
          ['session-001.md'],
          AbortSignal.timeout(5_000),
        );

        // Verify no new files were created in the memory directory
        const filesAfter = new Set(await readdir(memoryDir));
        expect(filesAfter).toEqual(filesBefore);

        // Verify MEMORY.md index was not modified
        const indexAfter = await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8');
        expect(indexAfter).toBe(indexBefore);

        // Verify the result still reports operations correctly
        expect(result.operationsApplied + result.operationsSkipped).toBe(
          operations.length,
        );
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-extraction, Property 12: Index updated if and only if operations were applied
describe('Property 12: Index updated if and only if operations were applied', () => {
  // Validates: Requirements 7.1, 7.4
  let tmpDir: string;
  let memoryDir: string;
  let sessionDir: string;

  const makeConfig = (overrides: Partial<MemconsolidateConfig> = {}): MemconsolidateConfig => ({
    memoryDirectory: memoryDir,
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
    extractionEnabled: true,
    extractionIntervalMs: 60_000,
    maxExtractionSessionChars: 5_000,
    ...overrides,
  });

  const makeMockBackend = (operations: FileOperation[]): LlmBackend => ({
    name: 'mock',
    initialize: async () => {},
    consolidate: async () => ({
      operations,
      reasoning: 'index update test',
    }),
  });

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `idx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    memoryDir = join(tmpDir, 'memory');
    sessionDir = join(tmpDir, 'sessions');
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    // Create an empty MEMORY.md index
    await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

    // Create a session file so buildExtractionPrompt can read it
    await writeFile(
      join(sessionDir, 'session-001.md'),
      '# Session\nUser discussed project architecture.',
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('index contains entries for created/updated files when operations are applied', async () => {
    const memoryTypeArb = fc.constantFrom<MemoryType>('user', 'feedback', 'project', 'reference');
    const filenameArb = fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/)
      .filter((n) => `${n}.md` !== 'MEMORY.md')
      .map((n) => `${n}.md`);
    const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,15}$/);
    const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
    const bodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?]{0,50}$/);

    const fileOpArb = fc
      .tuple(filenameArb, nameArb, descArb, memoryTypeArb, bodyArb)
      .map(([filename, name, desc, type, body]): FileOperation => ({
        op: 'create',
        path: filename,
        content: `---\nname: "${name}"\ndescription: "${desc}"\ntype: ${type}\n---\n${body}`,
      }));

    // Generate 1-3 unique-path operations per run
    const opsArb = fc
      .array(fileOpArb, { minLength: 1, maxLength: 3 })
      .map((ops) => {
        // Deduplicate by path to avoid conflicts
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
        // Reset MEMORY.md for each iteration
        await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

        // Clean up any leftover memory files from previous iterations
        const existingFiles = await readdir(memoryDir);
        for (const f of existingFiles) {
          if (f !== 'MEMORY.md') {
            await rm(join(memoryDir, f), { force: true });
          }
        }

        const config = makeConfig();
        const backend = makeMockBackend(operations);

        const result = await runExtraction(
          config,
          backend,
          ['session-001.md'],
          AbortSignal.timeout(5_000),
        );

        expect(result.operationsApplied).toBeGreaterThan(0);

        // Read back the index and verify it contains entries for each applied file
        const indexContent = await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8');
        for (const op of operations) {
          expect(indexContent).toContain(op.path);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('index remains unchanged when zero operations are applied', async () => {
    // Seed the index with some initial content
    const initialIndex = '- [Existing Memory](existing-memory.md) — Some existing memory\n';

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('empty-ops', 'all-invalid'),
        async (scenario) => {
          // Reset index to known state
          await writeFile(join(memoryDir, 'MEMORY.md'), initialIndex, 'utf-8');

          let operations: FileOperation[];
          if (scenario === 'empty-ops') {
            // LLM returns no operations
            operations = [];
          } else {
            // LLM returns only invalid operations (bad paths that will be skipped)
            operations = [
              { op: 'create', path: '../escape.md', content: '---\nname: "Bad"\ndescription: "bad"\ntype: user\n---\nbody' },
              { op: 'create', path: 'MEMORY.md', content: '---\nname: "Index"\ndescription: "bad"\ntype: user\n---\nbody' },
              { op: 'create', path: 'no-extension', content: '---\nname: "Bad"\ndescription: "bad"\ntype: user\n---\nbody' },
            ];
          }

          const config = makeConfig();
          const backend = makeMockBackend(operations);

          const result = await runExtraction(
            config,
            backend,
            ['session-001.md'],
            AbortSignal.timeout(5_000),
          );

          expect(result.operationsApplied).toBe(0);

          // Verify index was NOT modified
          const indexAfter = await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8');
          expect(indexAfter).toBe(initialIndex);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-extraction, Property 17: ExtractionResult contains all required fields
describe('Property 17: ExtractionResult contains all required fields', () => {
  // Validates: Requirements 9.1
  let tmpDir: string;
  let memoryDir: string;
  let sessionDir: string;

  const makeConfig = (overrides: Partial<MemconsolidateConfig> = {}): MemconsolidateConfig => ({
    memoryDirectory: memoryDir,
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
    extractionEnabled: true,
    extractionIntervalMs: 60_000,
    maxExtractionSessionChars: 5_000,
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `result-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    memoryDir = join(tmpDir, 'memory');
    sessionDir = join(tmpDir, 'sessions');
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    // Create an empty MEMORY.md index so readIndex works
    await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

    // Create a session file so buildExtractionPrompt can read it
    await writeFile(
      join(sessionDir, 'session-001.md'),
      '# Session\nUser discussed coding preferences.',
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('all numeric fields are non-negative and array fields are arrays for any mix of operations', async () => {
    const memoryTypeArb = fc.constantFrom<MemoryType>('user', 'feedback', 'project', 'reference');
    const filenameArb = fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/)
      .filter((n) => `${n}.md` !== 'MEMORY.md')
      .map((n) => `${n}.md`);
    const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,15}$/);
    const descArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
    const bodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?]{0,50}$/);

    // Valid operations that will pass validation
    const validOpArb = fc
      .tuple(
        fc.constantFrom<'create' | 'update'>('create', 'update'),
        filenameArb,
        nameArb,
        descArb,
        memoryTypeArb,
        bodyArb,
      )
      .map(([op, filename, name, desc, type, body]): FileOperation => ({
        op,
        path: filename,
        content: `---\nname: "${name}"\ndescription: "${desc}"\ntype: ${type}\n---\n${body}`,
      }));

    // Invalid operations that will be skipped (bad paths or missing frontmatter)
    const invalidOpArb = fc.constantFrom<FileOperation>(
      { op: 'create', path: '../escape.md', content: '---\nname: "Bad"\ndescription: "bad"\ntype: user\n---\nbody' },
      { op: 'create', path: 'no-extension', content: '---\nname: "Bad"\ndescription: "bad"\ntype: user\n---\nbody' },
      { op: 'create', path: 'valid.md', content: 'no frontmatter here' },
      { op: 'update', path: 'MEMORY.md', content: '---\nname: "Index"\ndescription: "bad"\ntype: user\n---\nbody' },
    );

    // Mix of valid and invalid operations (0-3 each)
    const opsArb = fc
      .tuple(
        fc.array(validOpArb, { minLength: 0, maxLength: 3 }),
        fc.array(invalidOpArb, { minLength: 0, maxLength: 3 }),
      )
      .map(([valid, invalid]) => {
        // Deduplicate valid ops by path
        const seen = new Set<string>();
        const dedupedValid = valid.filter((op) => {
          if (seen.has(op.path)) return false;
          seen.add(op.path);
          return true;
        });
        return [...dedupedValid, ...invalid];
      });

    await fc.assert(
      fc.asyncProperty(opsArb, async (operations) => {
        // Reset memory dir for each iteration
        await writeFile(join(memoryDir, 'MEMORY.md'), '', 'utf-8');
        const existingFiles = await readdir(memoryDir);
        for (const f of existingFiles) {
          if (f !== 'MEMORY.md') {
            await rm(join(memoryDir, f), { force: true });
          }
        }

        // Pre-create files for 'update' operations so they succeed
        for (const op of operations) {
          if (op.op === 'update' && validateOperationPath(op.path) && validateFileContent(op)) {
            await writeFile(join(memoryDir, op.path), 'placeholder', 'utf-8');
          }
        }

        const mockBackend: LlmBackend = {
          name: 'mock',
          initialize: async () => {},
          consolidate: async () => ({
            operations,
            reasoning: 'result fields test',
          }),
        };

        const config = makeConfig();
        const result = await runExtraction(
          config,
          mockBackend,
          ['session-001.md'],
          AbortSignal.timeout(5_000),
        );

        // Verify array fields are arrays
        expect(Array.isArray(result.filesCreated)).toBe(true);
        expect(Array.isArray(result.filesUpdated)).toBe(true);

        // Verify all numeric fields are non-negative numbers
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        expect(typeof result.promptLength).toBe('number');
        expect(result.promptLength).toBeGreaterThanOrEqual(0);

        expect(typeof result.operationsRequested).toBe('number');
        expect(result.operationsRequested).toBeGreaterThanOrEqual(0);

        expect(typeof result.operationsApplied).toBe('number');
        expect(result.operationsApplied).toBeGreaterThanOrEqual(0);

        expect(typeof result.operationsSkipped).toBe('number');
        expect(result.operationsSkipped).toBeGreaterThanOrEqual(0);

        // Verify applied + skipped <= requested (accounting for MEMORY.md filtering)
        expect(result.operationsApplied + result.operationsSkipped).toBeLessThanOrEqual(
          result.operationsRequested,
        );

        // Verify array lengths match applied counts
        expect(result.filesCreated.length + result.filesUpdated.length).toBeLessThanOrEqual(
          result.operationsApplied,
        );

        // Verify all entries in arrays are strings
        for (const f of result.filesCreated) {
          expect(typeof f).toBe('string');
        }
        for (const f of result.filesUpdated) {
          expect(typeof f).toBe('string');
        }
      }),
      { numRuns: 100 },
    );
  });
});
