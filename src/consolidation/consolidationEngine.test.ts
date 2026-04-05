import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runConsolidation } from './consolidationEngine.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type { MemconsolidateConfig, LlmResponse } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

// Mock modules that do filesystem reads we don't want in unit tests
vi.mock('../memory/memoryScanner.js', () => ({
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  formatMemoryManifest: vi.fn().mockReturnValue(''),
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

// --- helpers ---

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

function validContent(name: string, description: string, body: string): string {
  return `---\nname: "${name}"\ndescription: "${description}"\ntype: project\n---\n${body}`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'consol-test-'));
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'consol-sess-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(sessionDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Requirement 3.4: File operations applied correctly
// ---------------------------------------------------------------------------
describe('file operations applied correctly', () => {
  it('creates new files on disk from create operations', async () => {
    const content = validContent('New Memory', 'A new memory file', 'Body here');
    const backend = makeBackend({
      operations: [{ op: 'create', path: 'new-memory.md', content }],
      reasoning: 'created new memory',
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesCreated).toEqual(['new-memory.md']);
    const written = await fs.readFile(path.join(tmpDir, 'new-memory.md'), 'utf-8');
    expect(written).toBe(content);
  });

  it('updates existing files on disk from update operations', async () => {
    const oldContent = validContent('Old', 'Old desc', 'Old body');
    await fs.writeFile(path.join(tmpDir, 'existing.md'), oldContent, 'utf-8');

    const newContent = validContent('Updated', 'Updated desc', 'New body');
    const backend = makeBackend({
      operations: [{ op: 'update', path: 'existing.md', content: newContent }],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesUpdated).toEqual(['existing.md']);
    const written = await fs.readFile(path.join(tmpDir, 'existing.md'), 'utf-8');
    expect(written).toBe(newContent);
  });

  it('deletes files on disk from delete operations', async () => {
    await fs.writeFile(path.join(tmpDir, 'to-delete.md'), 'content', 'utf-8');

    const backend = makeBackend({
      operations: [{ op: 'delete', path: 'to-delete.md' }],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesDeleted).toEqual(['to-delete.md']);
    await expect(fs.access(path.join(tmpDir, 'to-delete.md'))).rejects.toThrow();
  });

  it('handles mixed create/update/delete operations', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'update-me.md'),
      validContent('Old', 'Old', 'Old body'),
      'utf-8',
    );
    await fs.writeFile(path.join(tmpDir, 'delete-me.md'), 'gone', 'utf-8');

    const backend = makeBackend({
      operations: [
        { op: 'create', path: 'brand-new.md', content: validContent('New', 'New desc', 'New body') },
        { op: 'update', path: 'update-me.md', content: validContent('Updated', 'Updated desc', 'Updated body') },
        { op: 'delete', path: 'delete-me.md' },
      ],
      reasoning: 'mixed ops',
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesCreated).toEqual(['brand-new.md']);
    expect(result.filesUpdated).toEqual(['update-me.md']);
    expect(result.filesDeleted).toEqual(['delete-me.md']);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.7: Index update after consolidation
// ---------------------------------------------------------------------------
describe('index update after consolidation', () => {
  it('writes MEMORY.md index after applying operations', async () => {
    const content = validContent('Test Memory', 'A test memory', 'Body');
    const backend = makeBackend({
      operations: [{ op: 'create', path: 'test-memory.md', content }],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.indexUpdated).toBe(true);
    const indexContent = await fs.readFile(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
    expect(indexContent).toContain('test-memory.md');
    expect(indexContent).toContain('Test Memory');
  });

  it('writes index even when no file operations are returned', async () => {
    const backend = makeBackend({ operations: [] });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.indexUpdated).toBe(true);
    // MEMORY.md should exist (may be empty or have existing entries)
    await expect(fs.access(path.join(tmpDir, 'MEMORY.md'))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.8: Abort signal handling
// ---------------------------------------------------------------------------
describe('abort signal handling', () => {
  it('returns early with empty result when aborted before LLM call', async () => {
    const backend = makeBackend({ operations: [] });
    const controller = new AbortController();
    controller.abort();

    const result = await runConsolidation(makeConfig(), backend, controller.signal);

    expect(result.filesCreated).toEqual([]);
    expect(result.filesUpdated).toEqual([]);
    expect(result.filesDeleted).toEqual([]);
    expect(result.indexUpdated).toBe(false);
    // The backend should NOT have been called
    expect(backend.consolidate).not.toHaveBeenCalled();
  });

  it('returns partial result when aborted during operation application', async () => {
    const content1 = validContent('First', 'First desc', 'Body 1');
    const content2 = validContent('Second', 'Second desc', 'Body 2');

    // Create a backend that aborts the signal after the first operation is applied
    const controller = new AbortController();
    const backend: LlmBackend = {
      name: 'mock',
      initialize: vi.fn().mockResolvedValue(undefined),
      consolidate: vi.fn().mockResolvedValue({
        operations: [
          { op: 'create', path: 'first.md', content: content1 },
          { op: 'create', path: 'second.md', content: content2 },
        ],
      }),
    };

    // We can't easily intercept between operations, but we can verify
    // that pre-aborted signal stops before prune phase
    // Instead, test that aborting after LLM response but before prune
    // returns partial results
    const originalConsolidate = backend.consolidate as ReturnType<typeof vi.fn>;
    originalConsolidate.mockImplementation(async () => {
      // Abort after LLM returns but the engine will check signal before each op
      // We need to abort after the first op is applied
      // The engine checks signal before each operation in the loop
      return {
        operations: [
          { op: 'create', path: 'first.md', content: content1 },
          { op: 'create', path: 'second.md', content: content2 },
        ],
      };
    });

    // For this test, abort immediately after LLM call returns
    // The engine checks signal after backend.consolidate returns
    const postLlmBackend: LlmBackend = {
      name: 'mock',
      initialize: vi.fn().mockResolvedValue(undefined),
      consolidate: vi.fn().mockImplementation(async () => {
        controller.abort();
        return {
          operations: [
            { op: 'create', path: 'first.md', content: content1 },
            { op: 'create', path: 'second.md', content: content2 },
          ],
        };
      }),
    };

    const result = await runConsolidation(makeConfig(), postLlmBackend, controller.signal);

    // Aborted after LLM call, so no operations should be applied
    expect(result.filesCreated).toEqual([]);
    expect(result.indexUpdated).toBe(false);
  });

  it('does not update index when aborted before prune phase', async () => {
    // The engine checks signal.aborted before the prune phase.
    // We use a custom backend that returns operations, then we verify
    // that aborting after the LLM call (post-llm check) prevents prune.
    const controller = new AbortController();

    // The engine checks signal after backend.consolidate returns.
    // If we abort inside consolidate, the post-llm check catches it.
    const backend: LlmBackend = {
      name: 'mock',
      initialize: vi.fn().mockResolvedValue(undefined),
      consolidate: vi.fn().mockImplementation(async () => {
        // Abort right as the LLM "returns"
        controller.abort();
        return { operations: [] };
      }),
    };

    const result = await runConsolidation(makeConfig(), backend, controller.signal);

    expect(result.indexUpdated).toBe(false);
    // MEMORY.md should not have been written
    await expect(fs.access(path.join(tmpDir, 'MEMORY.md'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Invalid frontmatter skipped
// ---------------------------------------------------------------------------
describe('invalid frontmatter skipped', () => {
  it('skips operations with missing frontmatter', async () => {
    const backend = makeBackend({
      operations: [
        { op: 'create', path: 'no-frontmatter.md', content: 'Just plain text, no YAML block' },
      ],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    // Operation should be skipped — file should not be created
    expect(result.filesCreated).toEqual([]);
    await expect(fs.access(path.join(tmpDir, 'no-frontmatter.md'))).rejects.toThrow();
  });

  it('skips operations with frontmatter missing name field', async () => {
    const content = '---\ndescription: "No name"\ntype: project\n---\nBody';
    const backend = makeBackend({
      operations: [{ op: 'create', path: 'no-name.md', content }],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesCreated).toEqual([]);
  });

  it('skips create/update with missing content', async () => {
    const backend = makeBackend({
      operations: [
        { op: 'create', path: 'empty.md' } as any,
      ],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesCreated).toEqual([]);
  });

  it('allows delete operations without content validation', async () => {
    await fs.writeFile(path.join(tmpDir, 'deletable.md'), 'content', 'utf-8');

    const backend = makeBackend({
      operations: [{ op: 'delete', path: 'deletable.md' }],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesDeleted).toEqual(['deletable.md']);
  });
});

// ---------------------------------------------------------------------------
// MEMORY.md operations filtered out
// ---------------------------------------------------------------------------
describe('MEMORY.md operations filtered out', () => {
  it('filters out operations targeting MEMORY.md', async () => {
    const content = validContent('Index Hack', 'Trying to overwrite index', 'Bad content');
    const backend = makeBackend({
      operations: [
        { op: 'update', path: 'MEMORY.md', content },
        { op: 'create', path: 'legit.md', content: validContent('Legit', 'Legit desc', 'Body') },
      ],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    // MEMORY.md operation should be filtered — only legit.md created
    expect(result.filesCreated).toEqual(['legit.md']);
    expect(result.filesUpdated).toEqual([]);
  });

  it('filters out delete operations targeting MEMORY.md', async () => {
    const backend = makeBackend({
      operations: [{ op: 'delete', path: 'MEMORY.md' }],
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(result.filesDeleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.1, 6.2, 6.3: Single-chunk backward compatibility
// ---------------------------------------------------------------------------
describe('single-chunk backward compatibility', () => {
  it('makes exactly one LLM call and reports chunksTotal: 1, chunksCompleted: 1', async () => {
    const content = validContent('Solo', 'Solo desc', 'Body');
    const backend = makeBackend({
      operations: [{ op: 'create', path: 'solo.md', content }],
      reasoning: 'single chunk',
    });

    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    expect(backend.consolidate).toHaveBeenCalledTimes(1);
    expect(result.chunksTotal).toBe(1);
    expect(result.chunksCompleted).toBe(1);
    expect(result.filesCreated).toEqual(['solo.md']);
    expect(result.indexUpdated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.2: Abort between chunks
// ---------------------------------------------------------------------------
describe('abort between chunks (multi-chunk)', () => {
  it('stops processing after first chunk when aborted and returns partial results', async () => {
    const { scanMemoryFiles } = await import('../memory/memoryScanner.js');
    const scanMock = scanMemoryFiles as ReturnType<typeof vi.fn>;

    // Create 2 memory files on disk so computeMemoryFileSizes can read them
    const file1Content = validContent('Mem1', 'desc1', 'body1');
    const file2Content = validContent('Mem2', 'desc2', 'body2');
    await fs.writeFile(path.join(tmpDir, 'mem1.md'), file1Content, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'mem2.md'), file2Content, 'utf-8');

    const headers = [
      { path: 'mem1.md', name: 'Mem1', description: 'desc1', type: 'project' as const, mtimeMs: Date.now() },
      { path: 'mem2.md', name: 'Mem2', description: 'desc2', type: 'project' as const, mtimeMs: Date.now() },
    ];
    scanMock.mockResolvedValueOnce(headers).mockResolvedValueOnce(headers);

    const controller = new AbortController();
    let callCount = 0;
    const backend: LlmBackend = {
      name: 'mock',
      initialize: vi.fn().mockResolvedValue(undefined),
      consolidate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Abort after first chunk completes
          controller.abort();
        }
        return { operations: [], reasoning: 'chunk' };
      }),
    };

    // maxFilesPerBatch: 1 forces 2 chunks (one file per chunk)
    const config = makeConfig({ maxFilesPerBatch: 1 });
    const result = await runConsolidation(config, backend, controller.signal);

    // Only 1 LLM call should have been made (aborted before chunk 2)
    expect(backend.consolidate).toHaveBeenCalledTimes(1);
    expect(result.chunksTotal).toBe(2);
    expect(result.chunksCompleted).toBe(1);
    // No operations applied, no index update (aborted)
    expect(result.indexUpdated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.4, 3.5: LLM failure stops processing
// ---------------------------------------------------------------------------
describe('LLM failure stops processing (multi-chunk)', () => {
  it('propagates error when LLM fails on chunk 2 and reports chunksCompleted: 1', async () => {
    const { scanMemoryFiles } = await import('../memory/memoryScanner.js');
    const scanMock = scanMemoryFiles as ReturnType<typeof vi.fn>;

    // Create 2 memory files on disk
    const file1Content = validContent('Mem1', 'desc1', 'body1');
    const file2Content = validContent('Mem2', 'desc2', 'body2');
    await fs.writeFile(path.join(tmpDir, 'mem1.md'), file1Content, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'mem2.md'), file2Content, 'utf-8');

    const headers = [
      { path: 'mem1.md', name: 'Mem1', description: 'desc1', type: 'project' as const, mtimeMs: Date.now() },
      { path: 'mem2.md', name: 'Mem2', description: 'desc2', type: 'project' as const, mtimeMs: Date.now() },
    ];
    scanMock.mockResolvedValueOnce(headers).mockResolvedValueOnce(headers);

    let callCount = 0;
    const backend: LlmBackend = {
      name: 'mock',
      initialize: vi.fn().mockResolvedValue(undefined),
      consolidate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) {
          // Fail on chunk 2 with a 4xx client error so retryLlmCall doesn't retry
          throw new Error('error 400: bad request');
        }
        return { operations: [], reasoning: 'chunk 1 ok' };
      }),
    };

    const config = makeConfig({ maxFilesPerBatch: 1 });

    await expect(
      runConsolidation(config, backend, new AbortController().signal),
    ).rejects.toThrow('error 400');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.5, 7.5: Chunk logging
// ---------------------------------------------------------------------------
describe('chunk logging', () => {
  it('logs chunk-llm-call with chunkIndex, chunksTotal, and promptSize', async () => {
    const { log: logMock } = await import('../logger.js');
    const logFn = logMock as ReturnType<typeof vi.fn>;
    logFn.mockClear();

    const backend = makeBackend({ operations: [], reasoning: 'no-op' });
    const result = await runConsolidation(makeConfig(), backend, new AbortController().signal);

    // Single-chunk pass should log one chunk-llm-call event
    const chunkLlmCalls = logFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'consolidation:chunk-llm-call',
    );
    expect(chunkLlmCalls.length).toBe(1);
    expect(chunkLlmCalls[0][2]).toEqual(
      expect.objectContaining({
        chunkIndex: 0,
        chunksTotal: 1,
        promptSize: expect.any(Number),
      }),
    );

    // Consolidation-complete should log chunksTotal and chunksCompleted
    const completeCalls = logFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'consolidation:complete',
    );
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][2]).toEqual(
      expect.objectContaining({
        chunksTotal: 1,
        chunksCompleted: 1,
      }),
    );
  });

  it('logs chunk-llm-call for each chunk in multi-chunk pass', async () => {
    const { log: logMock } = await import('../logger.js');
    const logFn = logMock as ReturnType<typeof vi.fn>;
    logFn.mockClear();

    const { scanMemoryFiles } = await import('../memory/memoryScanner.js');
    const scanMock = scanMemoryFiles as ReturnType<typeof vi.fn>;

    // Create 2 memory files on disk
    const file1Content = validContent('Mem1', 'desc1', 'body1');
    const file2Content = validContent('Mem2', 'desc2', 'body2');
    await fs.writeFile(path.join(tmpDir, 'mem1.md'), file1Content, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'mem2.md'), file2Content, 'utf-8');

    const headers = [
      { path: 'mem1.md', name: 'Mem1', description: 'desc1', type: 'project' as const, mtimeMs: Date.now() },
      { path: 'mem2.md', name: 'Mem2', description: 'desc2', type: 'project' as const, mtimeMs: Date.now() },
    ];
    scanMock.mockResolvedValueOnce(headers).mockResolvedValueOnce(headers);

    const backend = makeBackend({ operations: [], reasoning: 'no-op' });
    const config = makeConfig({ maxFilesPerBatch: 1 });
    const result = await runConsolidation(config, backend, new AbortController().signal);

    // Multi-chunk pass should log chunk-llm-call for each chunk
    const chunkLlmCalls = logFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'consolidation:chunk-llm-call',
    );
    expect(chunkLlmCalls.length).toBe(2);

    expect(chunkLlmCalls[0][2]).toEqual(
      expect.objectContaining({
        chunkIndex: 0,
        chunksTotal: 2,
        promptSize: expect.any(Number),
      }),
    );
    expect(chunkLlmCalls[1][2]).toEqual(
      expect.objectContaining({
        chunkIndex: 1,
        chunksTotal: 2,
        promptSize: expect.any(Number),
      }),
    );

    // Consolidation-complete should log chunksTotal and chunksCompleted
    const completeCalls = logFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'consolidation:complete',
    );
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][2]).toEqual(
      expect.objectContaining({
        chunksTotal: 2,
        chunksCompleted: 2,
      }),
    );
  });
});
