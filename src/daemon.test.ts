import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemconsolidateDaemon } from './daemon.js';
import type { MemconsolidateConfig } from './types.js';

// Suppress logger output during tests
vi.mock('./logger.js', () => ({ log: vi.fn() }));

// Mock the OpenAI backend so we don't need real API keys
vi.mock('./llm/openaiBackend.js', () => ({
  OpenAIBackend: class {
    name = 'openai';
    initialize = vi.fn().mockResolvedValue(undefined);
    consolidate = vi.fn().mockResolvedValue({ operations: [] });
  },
}));

// Mock trigger system — default: gates don't pass (no consolidation)
const mockEvaluateTrigger = vi.fn().mockResolvedValue({
  triggered: false,
  failedGate: 'time',
});
vi.mock('./trigger/triggerSystem.js', () => ({
  evaluateTrigger: (...args: unknown[]) => mockEvaluateTrigger(...args),
}));

// Mock lock functions
const mockReadLockState = vi.fn().mockResolvedValue({
  exists: false,
  holderPid: null,
  mtime: 0,
  isStale: false,
  holderAlive: false,
});
const mockReleaseLock = vi.fn().mockResolvedValue(undefined);
const mockRollbackLock = vi.fn().mockResolvedValue(undefined);
vi.mock('./lock/consolidationLock.js', () => ({
  readLockState: (...args: unknown[]) => mockReadLockState(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
  rollbackLock: (...args: unknown[]) => mockRollbackLock(...args),
}));

// Mock consolidation engine
const mockRunConsolidation = vi.fn().mockResolvedValue({
  filesCreated: [],
  filesUpdated: [],
  filesDeleted: [],
  indexUpdated: false,
  truncationApplied: false,
});
vi.mock('./consolidation/consolidationEngine.js', () => ({
  runConsolidation: (...args: unknown[]) => mockRunConsolidation(...args),
}));

// --- helpers ---

let tmpMemDir: string;
let tmpSessionDir: string;

function makeConfig(overrides: Partial<MemconsolidateConfig> = {}): MemconsolidateConfig {
  return {
    memoryDirectory: tmpMemDir,
    sessionDirectory: tmpSessionDir,
    minHours: 24,
    minSessions: 5,
    staleLockThresholdMs: 3_600_000,
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    llmBackend: 'openai',
    llmBackendOptions: { apiKey: 'test-key' },
    pollIntervalMs: 60_000,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpMemDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-mem-'));
  tmpSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-sess-'));
  vi.clearAllMocks();
  // Reset trigger mock to default (gates don't pass)
  mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
});

afterEach(async () => {
  await fs.rm(tmpMemDir, { recursive: true, force: true });
  await fs.rm(tmpSessionDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Requirement 11.1: Startup with valid config
// ---------------------------------------------------------------------------
describe('startup with valid config', () => {
  it('starts and stops without error', async () => {
    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();
    await daemon.stop();
  });

  it('performs initial gate check on start (Req 11.5)', async () => {
    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();

    // evaluateTrigger should have been called once for the initial check
    expect(mockEvaluateTrigger).toHaveBeenCalledTimes(1);

    await daemon.stop();
  });

  it('runs consolidation when all gates pass on initial check', async () => {
    mockEvaluateTrigger.mockResolvedValueOnce({
      triggered: true,
      sessionCount: 7,
      priorMtime: 1000,
    });

    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();

    expect(mockRunConsolidation).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);

    await daemon.stop();
  });
});

// ---------------------------------------------------------------------------
// Requirement 11.4: Memory directory creation
// ---------------------------------------------------------------------------
describe('memory directory creation', () => {
  it('creates memory directory if it does not exist', async () => {
    const newDir = path.join(tmpMemDir, 'nested', 'memory');
    // Remove the temp dir so the daemon has to create it
    await fs.rm(tmpMemDir, { recursive: true, force: true });

    const daemon = new MemconsolidateDaemon(makeConfig({ memoryDirectory: newDir }));
    await daemon.start();

    const stat = await fs.stat(newDir);
    expect(stat.isDirectory()).toBe(true);

    await daemon.stop();
  });

  it('does not fail if memory directory already exists', async () => {
    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();

    const stat = await fs.stat(tmpMemDir);
    expect(stat.isDirectory()).toBe(true);

    await daemon.stop();
  });
});

// ---------------------------------------------------------------------------
// Requirement 11.2: Graceful shutdown
// ---------------------------------------------------------------------------
describe('graceful shutdown', () => {
  it('stops polling after stop() is called', async () => {
    const daemon = new MemconsolidateDaemon(makeConfig({ pollIntervalMs: 1000 }));
    await daemon.start();
    await daemon.stop();

    // After stop, no further trigger evaluations should occur
    const callCount = mockEvaluateTrigger.mock.calls.length;
    // Wait a bit to confirm no new calls
    await new Promise((r) => setTimeout(r, 50));
    expect(mockEvaluateTrigger).toHaveBeenCalledTimes(callCount);
  });

  it('rolls back lock if stopped during consolidation', async () => {
    // Make the consolidation hang so we can stop mid-flight
    const consolidationStarted = new Promise<void>((resolve) => {
      mockRunConsolidation.mockImplementation(async (_cfg: unknown, _backend: unknown, signal: AbortSignal) => {
        resolve();
        // Wait until aborted
        await new Promise<void>((r) => {
          if (signal.aborted) { r(); return; }
          signal.addEventListener('abort', () => r(), { once: true });
        });
        throw new Error('aborted');
      });
    });

    mockEvaluateTrigger.mockResolvedValueOnce({
      triggered: true,
      sessionCount: 5,
      priorMtime: 42000,
    });

    const daemon = new MemconsolidateDaemon(makeConfig());
    // start() will call runOnce() which triggers consolidation
    const startPromise = daemon.start();

    // Wait for consolidation to begin
    await consolidationStarted;

    // Now stop — should abort and rollback
    await daemon.stop();
    await startPromise;

    expect(mockRollbackLock).toHaveBeenCalledWith(tmpMemDir, 42000);
  });

  it('runOnce is a no-op after stop', async () => {
    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();
    await daemon.stop();

    mockEvaluateTrigger.mockClear();
    await daemon.runOnce();

    // Should not evaluate triggers since daemon is stopped
    expect(mockEvaluateTrigger).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Consolidation failure handling
// ---------------------------------------------------------------------------
describe('consolidation failure handling', () => {
  it('rolls back lock on consolidation error', async () => {
    mockEvaluateTrigger.mockResolvedValueOnce({
      triggered: true,
      sessionCount: 5,
      priorMtime: 99000,
    });
    mockRunConsolidation.mockRejectedValueOnce(new Error('LLM exploded'));

    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();

    expect(mockRollbackLock).toHaveBeenCalledWith(tmpMemDir, 99000);
    expect(mockReleaseLock).not.toHaveBeenCalled();

    await daemon.stop();
  });

  it('continues running after a consolidation failure', async () => {
    mockEvaluateTrigger
      .mockResolvedValueOnce({ triggered: true, sessionCount: 5, priorMtime: 1000 })
      .mockResolvedValue({ triggered: false, failedGate: 'time' });
    mockRunConsolidation.mockRejectedValueOnce(new Error('transient failure'));

    const daemon = new MemconsolidateDaemon(makeConfig());
    await daemon.start();

    // Daemon should still be running — runOnce should work
    mockEvaluateTrigger.mockClear();
    await daemon.runOnce();
    expect(mockEvaluateTrigger).toHaveBeenCalledTimes(1);

    await daemon.stop();
  });
});
