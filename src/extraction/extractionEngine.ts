import { log } from '../logger.js';
import {
  readIndex,
  formatIndexEntry,
  truncateIndexContent,
  writeIndex,
  ENTRYPOINT_NAME,
} from '../memory/indexManager.js';
import {
  retryLlmCall,
  validateOperationPath,
  validateFileContent,
  applyOperation,
  buildUpdatedIndex,
} from '../consolidation/consolidationEngine.js';
import { buildExtractionPrompt } from './extractionPromptBuilder.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type {
  MemconsolidateConfig,
  ExtractionResult,
  FileOperation,
} from '../types.js';

/**
 * Run a single extraction pass.
 *
 * 1. Build prompt from memory manifest + modified session content
 * 2. Call LLM via retryLlmCall
 * 3. Validate and apply returned file operations
 * 4. Update MEMORY.md index (only if operations were applied)
 *
 * @param config - Daemon configuration
 * @param backend - Initialized LLM backend
 * @param modifiedSessionFiles - Filenames of sessions modified since cursor
 * @param signal - AbortSignal for graceful cancellation
 */
export async function runExtraction(
  config: MemconsolidateConfig,
  backend: LlmBackend,
  modifiedSessionFiles: string[],
  signal: AbortSignal,
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const result: ExtractionResult = {
    filesCreated: [],
    filesUpdated: [],
    durationMs: 0,
    promptLength: 0,
    operationsRequested: 0,
    operationsApplied: 0,
    operationsSkipped: 0,
  };

  // --- Phase 1: Build prompt ---
  if (signal.aborted) {
    log('info', 'extraction:aborted', { phase: 'pre-prompt' });
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const existingIndex = await readIndex(config.memoryDirectory);

  const prompt = await buildExtractionPrompt(
    config.memoryDirectory,
    modifiedSessionFiles,
    config.sessionDirectory,
    config.maxExtractionSessionChars,
    config.maxMemoryContentChars,
  );
  result.promptLength = prompt.length;

  // --- Phase 2: Call LLM ---
  if (signal.aborted) {
    log('info', 'extraction:aborted', { phase: 'pre-llm' });
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const llmResponse = await retryLlmCall(backend, prompt, 3, signal);

  if (signal.aborted) {
    log('info', 'extraction:aborted', { phase: 'post-llm' });
    result.durationMs = Date.now() - startTime;
    return result;
  }

  log('info', 'extraction:llm-response', {
    operationCount: llmResponse.operations.length,
    reasoning: llmResponse.reasoning,
  });

  // Filter out operations targeting the index file — we manage that ourselves
  const operations = llmResponse.operations.filter(
    (op) => op.path !== ENTRYPOINT_NAME,
  );
  result.operationsRequested = llmResponse.operations.length;

  // --- Phase 3: Validate and apply file operations ---
  for (const op of operations) {
    if (signal.aborted) {
      log('info', 'extraction:aborted', { phase: 'apply-ops' });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    if (!validateOperationPath(op.path)) {
      log('warn', 'extraction:unsafe-path', { path: op.path, op: op.op });
      result.operationsSkipped++;
      continue;
    }

    if (!validateFileContent(op)) {
      log('warn', 'extraction:skip-invalid-op', { path: op.path, op: op.op });
      result.operationsSkipped++;
      continue;
    }

    if (config.dryRun) {
      log('info', `extraction:dry-run-${op.op}`, {
        path: op.path,
        contentLength: op.content?.length,
      });
    } else {
      await applyOperation(config.memoryDirectory, op);
    }
    result.operationsApplied++;

    switch (op.op) {
      case 'create':
        result.filesCreated.push(op.path);
        break;
      case 'update':
        result.filesUpdated.push(op.path);
        break;
    }
  }

  // --- Phase 4: Update index (only if operations were applied) ---
  if (result.operationsApplied > 0) {
    if (signal.aborted) {
      log('info', 'extraction:aborted', { phase: 'index-update' });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const updatedEntries = await buildUpdatedIndex(
      config.memoryDirectory,
      existingIndex,
      operations,
    );

    const rawIndex = updatedEntries.map(formatIndexEntry).join('\n') + '\n';
    const { content: truncatedContent, truncated } = truncateIndexContent(
      rawIndex,
      config.maxIndexLines,
      config.maxIndexBytes,
    );

    if (config.dryRun) {
      log('info', 'extraction:dry-run-index', {
        entries: updatedEntries.length,
        truncated,
        contentLength: truncatedContent.length,
      });
    } else {
      await writeIndex(config.memoryDirectory, updatedEntries);
    }
  }

  log('info', 'extraction:complete', {
    created: result.filesCreated.length,
    updated: result.filesUpdated.length,
    durationMs: Date.now() - startTime,
    promptLength: result.promptLength,
    operationsRequested: result.operationsRequested,
    operationsApplied: result.operationsApplied,
    operationsSkipped: result.operationsSkipped,
    dryRun: config.dryRun,
  });

  result.durationMs = Date.now() - startTime;
  return result;
}
