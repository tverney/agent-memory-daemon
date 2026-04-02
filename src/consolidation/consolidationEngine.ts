import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';
import { parseFrontmatter } from '../memory/frontmatter.js';
import { scanMemoryFiles } from '../memory/memoryScanner.js';
import {
  readIndex,
  writeIndex,
  truncateIndexContent,
  formatIndexEntry,
  ENTRYPOINT_NAME,
} from '../memory/indexManager.js';
import { buildConsolidationPrompt } from './promptBuilder.js';
import type { LlmBackend } from '../llm/llmBackend.js';
import type {
  MemconsolidateConfig,
  ConsolidationResult,
  FileOperation,
  IndexEntry,
  LlmResponse,
} from '../types.js';

/** Retry transient LLM failures with exponential backoff. */
async function retryLlmCall(
  backend: LlmBackend,
  prompt: string,
  maxRetries: number = 3,
  signal?: AbortSignal,
): Promise<LlmResponse> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await backend.consolidate(prompt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status = extractHttpStatus(lastError.message);
      // Don't retry client errors (4xx) except 429 (rate limit)
      if (status !== null && status >= 400 && status < 500 && status !== 429) {
        throw lastError;
      }
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
        log('warn', 'consolidation:llm-retry', {
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          reason: lastError.message.slice(0, 200),
        });
        await sleep(delayMs, signal);
      }
    }
  }
  throw lastError!;
}

function extractHttpStatus(message: string): number | null {
  const match = message.match(/error (\d{3})/i);
  return match ? parseInt(match[1], 10) : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

/**
 * Validate that a file operation path is safe — must be a simple filename
 * within the memory directory. Rejects path traversal, absolute paths,
 * and attempts to target the index file.
 */
function validateOperationPath(opPath: string): boolean {
  // Must not be empty
  if (!opPath || opPath.trim().length === 0) return false;

  // Must not be absolute
  if (path.isAbsolute(opPath)) return false;

  // Must not contain path traversal
  if (opPath.includes('..')) return false;
  if (opPath.includes('/') || opPath.includes('\\')) return false;

  // Must not contain URL-encoded traversal sequences
  if (/%2[eE]/i.test(opPath) || /%2[fF]/i.test(opPath) || /%5[cC]/i.test(opPath)) return false;

  // Must end in .md
  if (!opPath.endsWith('.md')) return false;

  // Must not target the index file
  if (opPath === ENTRYPOINT_NAME) return false;

  return true;
}

/**
 * Validate that a file operation's content has valid frontmatter.
 * Returns true if valid, false otherwise.
 */
function validateFileContent(op: FileOperation): boolean {
  if (op.op === 'delete') return true;
  if (!op.content) {
    log('warn', 'consolidation:missing-content', { path: op.path, op: op.op });
    return false;
  }
  const parsed = parseFrontmatter(op.content);
  if (!parsed) {
    log('warn', 'consolidation:invalid-frontmatter', { path: op.path });
    return false;
  }
  if (!parsed.frontmatter.name) {
    log('warn', 'consolidation:missing-name', { path: op.path });
    return false;
  }
  return true;
}

/**
 * Apply a single file operation to the memory directory.
 */
async function applyOperation(
  memoryDir: string,
  op: FileOperation,
): Promise<void> {
  const filePath = path.join(memoryDir, op.path);

  switch (op.op) {
    case 'create':
    case 'update':
      await fs.writeFile(filePath, op.content!, 'utf-8');
      log('info', `consolidation:file-${op.op}`, { path: op.path });
      break;
    case 'delete':
      try {
        await fs.unlink(filePath);
        log('info', 'consolidation:file-delete', { path: op.path });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        log('warn', 'consolidation:delete-not-found', { path: op.path });
      }
      break;
  }
}

/**
 * Build an updated index from the current memory files after operations are applied.
 * Merges existing index entries with new/updated files and removes deleted entries.
 */
async function buildUpdatedIndex(
  memoryDir: string,
  existingIndex: IndexEntry[],
  operations: FileOperation[],
): Promise<IndexEntry[]> {
  const deletedFiles = new Set(
    operations.filter((o) => o.op === 'delete').map((o) => o.path),
  );

  // Start with existing entries, removing deleted ones
  const indexMap = new Map<string, IndexEntry>();
  for (const entry of existingIndex) {
    if (!deletedFiles.has(entry.file)) {
      indexMap.set(entry.file, entry);
    }
  }

  // Add/update entries for created/updated files
  const modifiedOps = operations.filter(
    (o) => o.op === 'create' || o.op === 'update',
  );
  for (const op of modifiedOps) {
    const parsed = parseFrontmatter(op.content!);
    if (parsed) {
      indexMap.set(op.path, {
        title: parsed.frontmatter.name,
        file: op.path,
        description: parsed.frontmatter.description,
      });
    }
  }

  // Scan memory dir to pick up any files not yet in the index
  const memories = await scanMemoryFiles(memoryDir);
  for (const mem of memories) {
    if (!indexMap.has(mem.path) && !deletedFiles.has(mem.path)) {
      indexMap.set(mem.path, {
        title: mem.name,
        file: mem.path,
        description: mem.description,
      });
    }
  }

  return Array.from(indexMap.values());
}

/**
 * Run a full four-phase consolidation pass.
 *
 * 1. Orient: scan memory dir, read index, read memory files
 * 2. Gather: identify new info from recent files and sessions
 * 3. Consolidate: send prompt to LLM backend, apply returned file operations
 * 4. Prune: update MEMORY.md index, enforce size budget, remove stale entries
 *
 * @param config - Daemon configuration
 * @param backend - Initialized LLM backend
 * @param signal - AbortSignal for graceful cancellation
 */
export async function runConsolidation(
  config: MemconsolidateConfig,
  backend: LlmBackend,
  signal: AbortSignal,
): Promise<ConsolidationResult> {
  const startTime = Date.now();
  const result: ConsolidationResult = {
    filesCreated: [],
    filesUpdated: [],
    filesDeleted: [],
    indexUpdated: false,
    truncationApplied: false,
    durationMs: 0,
    promptLength: 0,
    operationsRequested: 0,
    operationsApplied: 0,
    operationsSkipped: 0,
  };

  // --- Phase 1 & 2: Orient + Gather (handled by prompt builder) ---
  log('info', 'consolidation:phase', { phase: 'orient+gather' });

  if (signal.aborted) {
    log('info', 'consolidation:aborted', { phase: 'orient+gather' });
    return result;
  }

  const existingIndex = await readIndex(config.memoryDirectory);

  const prompt = await buildConsolidationPrompt(
    config.memoryDirectory,
    config.sessionDirectory,
    undefined,
    config,
  );
  result.promptLength = prompt.length;

  if (signal.aborted) {
    log('info', 'consolidation:aborted', { phase: 'pre-llm' });
    return result;
  }

  // --- Phase 3: Consolidate ---
  log('info', 'consolidation:phase', { phase: 'consolidate' });

  const llmResponse = await retryLlmCall(backend, prompt, 3, signal);

  if (signal.aborted) {
    log('info', 'consolidation:aborted', { phase: 'post-llm' });
    return result;
  }

  log('info', 'consolidation:llm-response', {
    operationCount: llmResponse.operations.length,
    reasoning: llmResponse.reasoning,
  });

  // Filter out operations targeting the index file — we manage that ourselves
  const operations = llmResponse.operations.filter(
    (op) => op.path !== ENTRYPOINT_NAME,
  );
  result.operationsRequested = llmResponse.operations.length;

  // Validate and apply file operations
  for (const op of operations) {
    if (signal.aborted) {
      log('info', 'consolidation:aborted', { phase: 'apply-ops' });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    if (!validateOperationPath(op.path)) {
      log('warn', 'consolidation:unsafe-path', { path: op.path, op: op.op });
      result.operationsSkipped++;
      continue;
    }

    if (!validateFileContent(op)) {
      log('warn', 'consolidation:skip-invalid-op', { path: op.path, op: op.op });
      result.operationsSkipped++;
      continue;
    }

    if (config.dryRun) {
      log('info', `consolidation:dry-run-${op.op}`, {
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
      case 'delete':
        result.filesDeleted.push(op.path);
        break;
    }
  }

  // --- Phase 4: Prune ---
  log('info', 'consolidation:phase', { phase: 'prune' });

  if (signal.aborted) {
    log('info', 'consolidation:aborted', { phase: 'prune' });
    return result;
  }

  const updatedEntries = await buildUpdatedIndex(
    config.memoryDirectory,
    existingIndex,
    operations,
  );

  // Format and truncate the index
  const rawIndex = updatedEntries.map(formatIndexEntry).join('\n') + '\n';
  const { content: truncatedContent, truncated } = truncateIndexContent(
    rawIndex,
    config.maxIndexLines,
    config.maxIndexBytes,
  );

  result.truncationApplied = truncated;

  if (config.dryRun) {
    log('info', 'consolidation:dry-run-index', {
      entries: updatedEntries.length,
      truncated,
      contentLength: truncatedContent.length,
    });
  } else {
    const indexPath = path.join(config.memoryDirectory, ENTRYPOINT_NAME);
    await fs.writeFile(indexPath, truncatedContent, 'utf-8');
  }
  result.indexUpdated = true;

  log('info', 'consolidation:complete', {
    created: result.filesCreated.length,
    updated: result.filesUpdated.length,
    deleted: result.filesDeleted.length,
    indexUpdated: result.indexUpdated,
    truncationApplied: result.truncationApplied,
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
