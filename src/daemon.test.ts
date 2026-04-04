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
const mockTryAcquireLock = vi.fn().mockResolvedValue({ acquired: false, priorMtime: 0 });
vi.mock('./lock/consolidationLock.js', () => ({
  readLockState: (...args: unknown[]) => mockReadLockState(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
  rollbackLock: (...args: unknown[]) => mockRollbackLock(...args),
  tryAcquireLock: (...args: unknown[]) => mockTryAcquireLock(...args),
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

// Mock extraction modules — default: no extraction triggers
const mockEvaluateExtractionTrigger = vi.fn().mockResolvedValue({
  triggered: false,
  modifiedFiles: [],
});
vi.mock('./extraction/extractionTrigger.js', () => ({
  evaluateExtractionTrigger: (...args: unknown[]) => mockEvaluateExtractionTrigger(...args),
}));

const mockReadExtractionCursor = vi.fn().mockResolvedValue(0);
const mockWriteExtractionCursor = vi.fn().mockResolvedValue(undefined);
vi.mock('./extraction/cursorManager.js', () => ({
  readExtractionCursor: (...args: unknown[]) => mockReadExtractionCursor(...args),
  writeExtractionCursor: (...args: unknown[]) => mockWriteExtractionCursor(...args),
}));

const mockRunExtraction = vi.fn().mockResolvedValue({
  filesCreated: [],
  filesUpdated: [],
  durationMs: 100,
  promptLength: 500,
  operationsRequested: 0,
  operationsApplied: 0,
  operationsSkipped: 0,
});
vi.mock('./extraction/extractionEngine.js', () => ({
  runExtraction: (...args: unknown[]) => mockRunExtraction(...args),
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
    maxSessionContentChars: 50_000,
    maxMemoryContentChars: 50_000,
    dryRun: false,
    minConsolidationIntervalMs: 60_000,
    extractionEnabled: false,
    extractionIntervalMs: 60_000,
    maxExtractionSessionChars: 5_000,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpMemDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-mem-'));
  tmpSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-sess-'));
  vi.clearAllMocks();
  // Reset trigger mock to default (gates don't pass)
  mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
  // Reset extraction mocks to defaults
  mockEvaluateExtractionTrigger.mockResolvedValue({ triggered: false, modifiedFiles: [] });
  mockReadExtractionCursor.mockResolvedValue(0);
  mockTryAcquireLock.mockResolvedValue({ acquired: false, priorMtime: 0 });
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

// Feature: memory-extraction, Property 6: Mutual exclusion between extraction and consolidation
import fc from 'fast-check';

describe('Property 6: Mutual exclusion between extraction and consolidation', () => {
  // **Validates: Requirements 3.1, 3.2**

  it('when consolidation is in-progress, a concurrent runOnce() does not start extraction', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (_arbitrary) => {
        vi.clearAllMocks();
        mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
        mockEvaluateExtractionTrigger.mockResolvedValue({ triggered: false, modifiedFiles: [] });
        mockReadExtractionCursor.mockResolvedValue(0);
        mockTryAcquireLock.mockResolvedValue({ acquired: false, priorMtime: 0 });

        // Start daemon normally (no triggers on initial runOnce)
        const config = makeConfig({ extractionEnabled: true });
        const daemon = new MemconsolidateDaemon(config);
        await daemon.start();

        // Now set up a hanging consolidation for the next runOnce
        let resolveConsolidation!: () => void;
        const consolidationStarted = new Promise<void>((resolve) => {
          mockRunConsolidation.mockImplementation(async () => {
            resolve();
            await new Promise<void>((r) => { resolveConsolidation = r; });
            return {
              filesCreated: [], filesUpdated: [], filesDeleted: [],
              indexUpdated: false, truncationApplied: false,
              durationMs: 10, promptLength: 100,
              operationsRequested: 0, operationsApplied: 0, operationsSkipped: 0,
            };
          });
        });

        mockEvaluateTrigger.mockResolvedValueOnce({
          triggered: true, sessionCount: 5, priorMtime: 1000,
        });

        // Fire runOnce without awaiting — it will hang inside consolidation
        const runOncePromise = daemon.runOnce();
        await consolidationStarted;

        // Reset extraction mocks to track the concurrent call
        mockEvaluateExtractionTrigger.mockClear();
        mockRunExtraction.mockClear();

        // Call runOnce again — should be a no-op due to re-entry guard
        await daemon.runOnce();

        expect(mockEvaluateExtractionTrigger).not.toHaveBeenCalled();
        expect(mockRunExtraction).not.toHaveBeenCalled();

        // Clean up
        resolveConsolidation();
        await runOncePromise;
        await daemon.stop();
      }),
      { numRuns: 100 },
    );
  }, 60_000);

  it('when extraction is in-progress, a concurrent runOnce() does not start consolidation', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (_arbitrary) => {
        vi.clearAllMocks();
        mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
        mockEvaluateExtractionTrigger.mockResolvedValue({ triggered: false, modifiedFiles: [] });
        mockReadExtractionCursor.mockResolvedValue(0);
        mockTryAcquireLock.mockResolvedValue({ acquired: false, priorMtime: 0 });

        // Start daemon normally (no triggers on initial runOnce)
        const config = makeConfig({ extractionEnabled: true });
        const daemon = new MemconsolidateDaemon(config);
        await daemon.start();

        // Now set up a hanging extraction for the next runOnce
        let resolveExtraction!: () => void;
        const extractionStarted = new Promise<void>((resolve) => {
          mockRunExtraction.mockImplementation(async () => {
            resolve();
            await new Promise<void>((r) => { resolveExtraction = r; });
            return {
              filesCreated: [], filesUpdated: [],
              durationMs: 10, promptLength: 100,
              operationsRequested: 0, operationsApplied: 0, operationsSkipped: 0,
            };
          });
        });

        mockEvaluateExtractionTrigger.mockResolvedValueOnce({
          triggered: true, modifiedFiles: ['session-001.md'],
        });
        mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 500 });

        // Fire runOnce without awaiting — it will hang inside extraction
        const runOncePromise = daemon.runOnce();
        await extractionStarted;

        // Reset consolidation mocks to track the concurrent call
        mockEvaluateTrigger.mockClear();
        mockRunConsolidation.mockClear();

        // Call runOnce again — should be a no-op due to re-entry guard
        await daemon.runOnce();

        expect(mockEvaluateTrigger).not.toHaveBeenCalled();
        expect(mockRunConsolidation).not.toHaveBeenCalled();

        // Clean up
        resolveExtraction();
        await runOncePromise;
        await daemon.stop();
      }),
      { numRuns: 100 },
    );
  }, 60_000);

  it('consolidation and extraction never run simultaneously', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          consolidationFirst: fc.boolean(),
          sessionCount: fc.integer({ min: 1, max: 20 }),
        }),
        async ({ consolidationFirst }) => {
          vi.clearAllMocks();
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockEvaluateExtractionTrigger.mockResolvedValue({ triggered: false, modifiedFiles: [] });
          mockReadExtractionCursor.mockResolvedValue(0);
          mockTryAcquireLock.mockResolvedValue({ acquired: false, priorMtime: 0 });

          // Track whether both operations are ever active at the same time
          let consolidationActive = false;
          let extractionActive = false;
          let simultaneousViolation = false;

          // Start daemon normally (no triggers on initial runOnce)
          const config = makeConfig({ extractionEnabled: true });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // Set up a hanging operation for the next runOnce
          let resolveOp!: () => void;
          const opStarted = new Promise<void>((resolve) => {
            if (consolidationFirst) {
              mockRunConsolidation.mockImplementation(async () => {
                consolidationActive = true;
                if (extractionActive) simultaneousViolation = true;
                resolve();
                await new Promise<void>((r) => { resolveOp = r; });
                consolidationActive = false;
                return {
                  filesCreated: [], filesUpdated: [], filesDeleted: [],
                  indexUpdated: false, truncationApplied: false,
                  durationMs: 10, promptLength: 100,
                  operationsRequested: 0, operationsApplied: 0, operationsSkipped: 0,
                };
              });
            } else {
              mockRunExtraction.mockImplementation(async () => {
                extractionActive = true;
                if (consolidationActive) simultaneousViolation = true;
                resolve();
                await new Promise<void>((r) => { resolveOp = r; });
                extractionActive = false;
                return {
                  filesCreated: [], filesUpdated: [],
                  durationMs: 10, promptLength: 100,
                  operationsRequested: 0, operationsApplied: 0, operationsSkipped: 0,
                };
              });
            }
          });

          if (consolidationFirst) {
            mockEvaluateTrigger.mockResolvedValueOnce({
              triggered: true, sessionCount: 5, priorMtime: 1000,
            });
          } else {
            mockEvaluateExtractionTrigger.mockResolvedValueOnce({
              triggered: true, modifiedFiles: ['session-001.md'],
            });
            mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 500 });
          }

          // Fire runOnce without awaiting — it will hang inside the operation
          const runOncePromise = daemon.runOnce();
          await opStarted;

          // Second runOnce while first op is in-flight — should be no-op
          await daemon.runOnce();

          expect(simultaneousViolation).toBe(false);

          resolveOp();
          await runOncePromise;
          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});

// Feature: memory-extraction, Property 14: Extraction runs if and only if enabled
describe('Property 14: Extraction runs if and only if enabled', () => {
  // **Validates: Requirements 1.5, 10.1**

  it('no extraction triggers evaluated when extractionEnabled is false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10_000, max: 300_000 }), // extractionIntervalMs
        async (extractionIntervalMs) => {
          vi.clearAllMocks();
          // Consolidation gates don't pass — so extraction path would normally run
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);
          mockEvaluateExtractionTrigger.mockResolvedValue({
            triggered: true,
            modifiedFiles: ['session-001.md'],
          });

          const config = makeConfig({
            extractionEnabled: false,
            extractionIntervalMs,
          });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // Also call runOnce explicitly to double-check
          await daemon.runOnce();

          // Extraction trigger should never be evaluated
          expect(mockEvaluateExtractionTrigger).not.toHaveBeenCalled();
          expect(mockRunExtraction).not.toHaveBeenCalled();
          expect(mockReadExtractionCursor).not.toHaveBeenCalled();

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);

  it('extraction triggers are evaluated when extractionEnabled is true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10_000, max: 300_000 }), // extractionIntervalMs
        async (extractionIntervalMs) => {
          vi.clearAllMocks();
          // Consolidation gates don't pass — so extraction path runs
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);
          // Trigger fires but lock not acquired — extraction won't fully run
          mockEvaluateExtractionTrigger.mockResolvedValue({
            triggered: true,
            modifiedFiles: ['session-001.md'],
          });
          mockTryAcquireLock.mockResolvedValue({ acquired: false, priorMtime: 0 });

          const config = makeConfig({
            extractionEnabled: true,
            extractionIntervalMs,
          });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // Extraction trigger should have been evaluated on the initial runOnce
          expect(mockEvaluateExtractionTrigger).toHaveBeenCalled();
          expect(mockReadExtractionCursor).toHaveBeenCalled();

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});

// Feature: memory-extraction, Property 15: Extraction rate limit enforced
describe('Property 15: Extraction rate limit enforced', () => {
  // **Validates: Requirements 10.3**

  it('second extraction attempt within extractionIntervalMs is skipped', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10_000, max: 300_000 }), // extractionIntervalMs
        async (extractionIntervalMs) => {
          vi.clearAllMocks();
          // Default: no consolidation triggers
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);

          const config = makeConfig({
            extractionEnabled: true,
            extractionIntervalMs,
          });
          const daemon = new MemconsolidateDaemon(config);

          // --- First runOnce: extraction triggers and succeeds ---
          mockEvaluateExtractionTrigger.mockResolvedValueOnce({
            triggered: true,
            modifiedFiles: ['session-001.md'],
          });
          mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 100 });
          mockRunExtraction.mockResolvedValueOnce({
            filesCreated: [],
            filesUpdated: [],
            durationMs: 50,
            promptLength: 200,
            operationsRequested: 1,
            operationsApplied: 1,
            operationsSkipped: 0,
          });

          await daemon.start();

          // Verify extraction ran once
          expect(mockRunExtraction).toHaveBeenCalledTimes(1);

          // --- Second runOnce: should be rate-limited ---
          // Reset mocks to track the second call
          mockEvaluateExtractionTrigger.mockClear();
          mockRunExtraction.mockClear();

          // Set up extraction trigger to fire again (but it should never be reached)
          mockEvaluateExtractionTrigger.mockResolvedValue({
            triggered: true,
            modifiedFiles: ['session-002.md'],
          });
          mockTryAcquireLock.mockResolvedValue({ acquired: true, priorMtime: 200 });

          // Call runOnce immediately — within extractionIntervalMs
          await daemon.runOnce();

          // Extraction trigger should NOT have been evaluated (rate limited before that check)
          expect(mockEvaluateExtractionTrigger).not.toHaveBeenCalled();
          expect(mockRunExtraction).not.toHaveBeenCalled();

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Import mocked logger for assertion in the tests below
// ---------------------------------------------------------------------------
import { log as mockLog } from './logger.js';

// ---------------------------------------------------------------------------
// Req 5.5: Abort signal handling during extraction
// ---------------------------------------------------------------------------
describe('abort signal handling during extraction (Req 5.5)', () => {
  it('passes an AbortSignal to runExtraction', async () => {
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 100 });
    mockRunExtraction.mockResolvedValueOnce({
      filesCreated: [], filesUpdated: [],
      durationMs: 10, promptLength: 100,
      operationsRequested: 0, operationsApplied: 0, operationsSkipped: 0,
    });

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    await daemon.start();

    // runExtraction should have been called with 4 args, the last being an AbortSignal
    expect(mockRunExtraction).toHaveBeenCalledTimes(1);
    const signal = mockRunExtraction.mock.calls[0][3];
    expect(signal).toBeInstanceOf(AbortSignal);

    await daemon.stop();
  });

  it('aborts the signal when daemon.stop() is called during extraction', async () => {
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });

    let capturedSignal: AbortSignal | null = null;
    const extractionStarted = new Promise<void>((resolve) => {
      mockRunExtraction.mockImplementation(
        async (_cfg: unknown, _backend: unknown, _files: unknown, signal: AbortSignal) => {
          capturedSignal = signal;
          resolve();
          // Hang until aborted
          await new Promise<void>((r) => {
            if (signal.aborted) { r(); return; }
            signal.addEventListener('abort', () => r(), { once: true });
          });
          throw new Error('aborted');
        },
      );
    });

    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 200 });

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    const startPromise = daemon.start();

    await extractionStarted;
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

    // Stop the daemon — should abort the signal
    await daemon.stop();
    await startPromise;

    expect(capturedSignal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Req 9.2, 9.3, 9.4: Log event names for extraction
// ---------------------------------------------------------------------------
describe('extraction log event names (Req 9.2, 9.3, 9.4)', () => {
  it('logs daemon:extraction-start when extraction begins', async () => {
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 100 });
    mockRunExtraction.mockResolvedValueOnce({
      filesCreated: [], filesUpdated: [],
      durationMs: 10, promptLength: 100,
      operationsRequested: 0, operationsApplied: 0, operationsSkipped: 0,
    });

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    await daemon.start();

    const logMock = vi.mocked(mockLog);
    const startCalls = logMock.mock.calls.filter(
      ([level, event]) => level === 'info' && event === 'daemon:extraction-start',
    );
    expect(startCalls.length).toBeGreaterThanOrEqual(1);
    // Verify it includes sessionCount data
    expect(startCalls[0][2]).toEqual(expect.objectContaining({ sessionCount: 1 }));

    await daemon.stop();
  });

  it('logs daemon:extraction-complete when extraction succeeds', async () => {
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md', 'session-002.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 100 });
    mockRunExtraction.mockResolvedValueOnce({
      filesCreated: ['new-memory.md'], filesUpdated: [],
      durationMs: 50, promptLength: 500,
      operationsRequested: 1, operationsApplied: 1, operationsSkipped: 0,
    });

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    await daemon.start();

    const logMock = vi.mocked(mockLog);
    const completeCalls = logMock.mock.calls.filter(
      ([level, event]) => level === 'info' && event === 'daemon:extraction-complete',
    );
    expect(completeCalls.length).toBe(1);

    await daemon.stop();
  });

  it('logs daemon:extraction-failed when extraction throws', async () => {
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 100 });
    mockRunExtraction.mockRejectedValueOnce(new Error('LLM timeout'));

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    await daemon.start();

    const logMock = vi.mocked(mockLog);
    const failedCalls = logMock.mock.calls.filter(
      ([level, event]) => level === 'error' && event === 'daemon:extraction-failed',
    );
    expect(failedCalls.length).toBe(1);
    expect(failedCalls[0][2]).toEqual(expect.objectContaining({ reason: 'LLM timeout' }));

    await daemon.stop();
  });
});

// ---------------------------------------------------------------------------
// Req 10.4: Initial extraction check on startup
// ---------------------------------------------------------------------------
describe('initial extraction check on startup (Req 10.4)', () => {
  it('evaluates extraction trigger during start() when extractionEnabled is true', async () => {
    // Consolidation gates don't pass — extraction path should run
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 50 });
    mockRunExtraction.mockResolvedValueOnce({
      filesCreated: ['extracted-memory.md'], filesUpdated: [],
      durationMs: 30, promptLength: 300,
      operationsRequested: 1, operationsApplied: 1, operationsSkipped: 0,
    });

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    await daemon.start();

    // Extraction should have run during the initial runOnce() call in start()
    expect(mockReadExtractionCursor).toHaveBeenCalled();
    expect(mockEvaluateExtractionTrigger).toHaveBeenCalled();
    expect(mockRunExtraction).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalled();
    expect(mockWriteExtractionCursor).toHaveBeenCalled();

    await daemon.stop();
  });
});

// ---------------------------------------------------------------------------
// Req 10.5: Shutdown rollback during extraction
// ---------------------------------------------------------------------------
describe('shutdown rollback during extraction (Req 10.5)', () => {
  it('rolls back lock when daemon.stop() is called during in-progress extraction', async () => {
    mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });

    const extractionStarted = new Promise<void>((resolve) => {
      mockRunExtraction.mockImplementation(
        async (_cfg: unknown, _backend: unknown, _files: unknown, signal: AbortSignal) => {
          resolve();
          // Hang until aborted
          await new Promise<void>((r) => {
            if (signal.aborted) { r(); return; }
            signal.addEventListener('abort', () => r(), { once: true });
          });
          throw new Error('aborted');
        },
      );
    });

    mockEvaluateExtractionTrigger.mockResolvedValueOnce({
      triggered: true,
      modifiedFiles: ['session-001.md'],
    });
    mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime: 7777 });

    const daemon = new MemconsolidateDaemon(makeConfig({ extractionEnabled: true }));
    const startPromise = daemon.start();

    // Wait for extraction to begin
    await extractionStarted;

    // Stop the daemon while extraction is in progress
    await daemon.stop();
    await startPromise;

    // Verify rollback was called with the extraction's priorMtime
    expect(mockRollbackLock).toHaveBeenCalledWith(tmpMemDir, 7777);
  });
});

// Feature: memory-extraction, Property 13: Cursor advances on success only
describe('Property 13: Cursor advances on success only', () => {
  // **Validates: Requirements 8.1, 8.2**

  it('writeExtractionCursor is called when extraction succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          extractionIntervalMs: fc.integer({ min: 10_000, max: 300_000 }),
          priorMtime: fc.integer({ min: 0, max: 1_000_000 }),
          sessionFile: fc.stringMatching(/^session-[a-z0-9]{1,8}\.md$/),
        }),
        async ({ extractionIntervalMs, priorMtime, sessionFile }) => {
          vi.clearAllMocks();
          // Consolidation gates don't pass — extraction path runs
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);
          mockEvaluateExtractionTrigger.mockResolvedValueOnce({
            triggered: true,
            modifiedFiles: [sessionFile],
          });
          mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime });
          mockRunExtraction.mockResolvedValueOnce({
            filesCreated: [],
            filesUpdated: [],
            durationMs: 50,
            promptLength: 200,
            operationsRequested: 1,
            operationsApplied: 1,
            operationsSkipped: 0,
          });

          const config = makeConfig({
            extractionEnabled: true,
            extractionIntervalMs,
          });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // On success, writeExtractionCursor must be called with the memory dir and a timestamp
          expect(mockWriteExtractionCursor).toHaveBeenCalledTimes(1);
          expect(mockWriteExtractionCursor.mock.calls[0][0]).toBe(tmpMemDir);
          const writtenTimestamp = mockWriteExtractionCursor.mock.calls[0][1];
          expect(typeof writtenTimestamp).toBe('number');
          expect(writtenTimestamp).toBeGreaterThan(0);

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);

  it('writeExtractionCursor is NOT called when extraction fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          extractionIntervalMs: fc.integer({ min: 10_000, max: 300_000 }),
          priorMtime: fc.integer({ min: 0, max: 1_000_000 }),
          errorMessage: fc.stringMatching(/^[A-Za-z ]{1,30}$/),
        }),
        async ({ extractionIntervalMs, priorMtime, errorMessage }) => {
          vi.clearAllMocks();
          // Consolidation gates don't pass — extraction path runs
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);
          mockEvaluateExtractionTrigger.mockResolvedValueOnce({
            triggered: true,
            modifiedFiles: ['session-001.md'],
          });
          mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime });
          mockRunExtraction.mockRejectedValueOnce(new Error(errorMessage));

          const config = makeConfig({
            extractionEnabled: true,
            extractionIntervalMs,
          });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // On failure, writeExtractionCursor must NOT be called (cursor unchanged, Req 8.2)
          expect(mockWriteExtractionCursor).not.toHaveBeenCalled();
          // Rollback should have been called instead
          expect(mockRollbackLock).toHaveBeenCalledWith(tmpMemDir, priorMtime);

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});

// Feature: memory-extraction, Property 7: Lock lifecycle — release on success, rollback on failure
describe('Property 7: Lock lifecycle — release on success, rollback on failure', () => {
  // **Validates: Requirements 3.4, 3.5, 3.6**

  it('on success, releaseLock is called (lock mtime advances)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          priorMtime: fc.integer({ min: 0, max: 1_000_000 }),
          sessionFile: fc.stringMatching(/^session-[a-z0-9]{1,8}\.md$/),
        }),
        async ({ priorMtime, sessionFile }) => {
          vi.clearAllMocks();
          // Consolidation gates don't pass — extraction path runs
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);
          mockEvaluateExtractionTrigger.mockResolvedValueOnce({
            triggered: true,
            modifiedFiles: [sessionFile],
          });
          mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime });
          mockRunExtraction.mockResolvedValueOnce({
            filesCreated: [],
            filesUpdated: [],
            durationMs: 50,
            promptLength: 200,
            operationsRequested: 1,
            operationsApplied: 1,
            operationsSkipped: 0,
          });

          const config = makeConfig({ extractionEnabled: true });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // On success, releaseLock must be called with the memory dir
          expect(mockReleaseLock).toHaveBeenCalledWith(tmpMemDir);
          // rollbackLock must NOT be called on success
          expect(mockRollbackLock).not.toHaveBeenCalled();

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);

  it('on failure, rollbackLock is called with priorMtime (lock mtime restored)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          priorMtime: fc.integer({ min: 0, max: 1_000_000 }),
          errorMessage: fc.stringMatching(/^[A-Za-z ]{1,30}$/),
        }),
        async ({ priorMtime, errorMessage }) => {
          vi.clearAllMocks();
          // Consolidation gates don't pass — extraction path runs
          mockEvaluateTrigger.mockResolvedValue({ triggered: false, failedGate: 'time' });
          mockReadExtractionCursor.mockResolvedValue(0);
          mockEvaluateExtractionTrigger.mockResolvedValueOnce({
            triggered: true,
            modifiedFiles: ['session-001.md'],
          });
          mockTryAcquireLock.mockResolvedValueOnce({ acquired: true, priorMtime });
          mockRunExtraction.mockRejectedValueOnce(new Error(errorMessage));

          const config = makeConfig({ extractionEnabled: true });
          const daemon = new MemconsolidateDaemon(config);
          await daemon.start();

          // On failure, rollbackLock must be called with the memory dir and priorMtime
          expect(mockRollbackLock).toHaveBeenCalledWith(tmpMemDir, priorMtime);
          // releaseLock must NOT be called on failure
          expect(mockReleaseLock).not.toHaveBeenCalled();

          await daemon.stop();
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});
