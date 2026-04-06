import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';
import { parseFrontmatter } from '../memory/frontmatter.js';
import { scanMemoryFiles, formatMemoryManifest } from '../memory/memoryScanner.js';
import {
  readIndex,
  writeIndex,
  truncateIndexContent,
  formatIndexEntry,
  ENTRYPOINT_NAME,
} from '../memory/indexManager.js';
import { buildConsolidationPrompt, buildChunkPrompt, buildSharedContext, buildSystemPrompt } from './promptBuilder.js';
import { planChunks, type MemoryFileWithSize } from './chunkPlanner.js';
import { mergeChunkResults, type ChunkResult } from './chunkMerger.js';
import type { LlmBackend, ConsolidateOptions } from '../llm/llmBackend.js';
import type {
  MemconsolidateConfig,
  ConsolidationResult,
  FileOperation,
  IndexEntry,
  LlmResponse,
} from '../types.js';

/** Retry transient LLM failures with exponential backoff. */
export async function retryLlmCall(
  backend: LlmBackend,
  prompt: string,
  maxRetries: number = 3,
  signal?: AbortSignal,
  options?: ConsolidateOptions,
): Promise<LlmResponse> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await backend.consolidate(prompt, options);
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
export function validateOperationPath(opPath: string): boolean {
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
export function validateFileContent(op: FileOperation): boolean {
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
export async function applyOperation(
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
export async function buildUpdatedIndex(
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
 * Compute total session content size by reading all session files.
 */
async function computeSessionContentSize(sessionDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(sessionDir);
    let totalSize = 0;
    for (const name of entries) {
      try {
        const filePath = path.join(sessionDir, name);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        totalSize += content.length;
      } catch {
        // Skip unreadable files
      }
    }
    return totalSize;
  } catch {
    return 0;
  }
}

/**
 * Scan memory files and compute their content sizes for chunk planning.
 */
async function computeMemoryFileSizes(
  memoryDir: string,
  memories: import('../types.js').MemoryHeader[],
): Promise<MemoryFileWithSize[]> {
  const results: MemoryFileWithSize[] = [];
  for (const header of memories) {
    try {
      const filePath = path.join(memoryDir, header.path);
      const content = await fs.readFile(filePath, 'utf-8');
      results.push({ header, contentSize: content.length });
    } catch {
      // If we can't read the file, include it with size 0
      results.push({ header, contentSize: 0 });
    }
  }
  return results;
}

/**
 * Run a full four-phase consolidation pass.
 *
 * 1. Orient: scan memory dir, read index, read memory files
 * 2. Gather: identify new info from recent files and sessions
 * 3. Consolidate: send prompt to LLM backend, apply returned file operations
 * 4. Prune: update MEMORY.md index, enforce size budget, remove stale entries
 *
 * Supports chunk-based processing: when the memory set is large, it splits
 * into multiple LLM calls and merges results. When content fits in one chunk,
 * it uses the existing single-pass behavior.
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
    orphansRemoved: [],
    indexUpdated: false,
    truncationApplied: false,
    durationMs: 0,
    promptLength: 0,
    operationsRequested: 0,
    operationsApplied: 0,
    operationsSkipped: 0,
    chunksTotal: 1,
    chunksCompleted: 0,
  };

  // --- Phase 1 & 2: Orient + Gather (handled by prompt builder) ---
  log('info', 'consolidation:phase', { phase: 'orient+gather' });

  if (signal.aborted) {
    log('info', 'consolidation:aborted', { phase: 'orient+gather' });
    return result;
  }

  const existingIndex = await readIndex(config.memoryDirectory);

  // Scan memory files and compute content sizes for chunk planning
  const memories = await scanMemoryFiles(config.memoryDirectory);
  const memoriesWithSizes = await computeMemoryFileSizes(config.memoryDirectory, memories);
  const sessionContentSize = await computeSessionContentSize(config.sessionDirectory);
  const manifest = formatMemoryManifest(memories);
  const manifestSize = manifest.length;

  // Plan chunks
  const chunkPlan = planChunks(
    memoriesWithSizes,
    sessionContentSize,
    manifestSize,
    config.maxPromptChars,
    config.maxFilesPerBatch,
  );
  result.chunksTotal = chunkPlan.chunks.length;

  // Pre-compute shared context once (index, sessions, manifest, staleness).
  // Reused across all chunks to avoid redundant filesystem reads.
  const shared = await buildSharedContext(
    config.memoryDirectory,
    config.sessionDirectory,
    memories,
  );

  // Build the stable system prompt (instructions + response format).
  // Backends that support prompt caching place this in a cacheable position
  // so chunks 2+ get a cache hit on the instruction prefix.
  const systemPrompt = buildSystemPrompt(shared.today);
  const llmOptions: ConsolidateOptions = { systemPrompt };

  let operations: FileOperation[];

  if (chunkPlan.chunks.length <= 1) {
    // --- Single chunk: use existing single-pass behavior ---
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
    log('info', 'consolidation:chunk-llm-call', {
      chunkIndex: 0,
      chunksTotal: 1,
      promptSize: prompt.length,
    });

    const llmResponse = await retryLlmCall(backend, prompt, 3, signal, llmOptions);
    result.chunksCompleted = 1;

    if (signal.aborted) {
      log('info', 'consolidation:aborted', { phase: 'post-llm' });
      return result;
    }

    log('info', 'consolidation:llm-response', {
      operationCount: llmResponse.operations.length,
      reasoning: llmResponse.reasoning,
    });

    // Filter out operations targeting the index file
    operations = llmResponse.operations.filter(
      (op) => op.path !== ENTRYPOINT_NAME,
    );
    result.operationsRequested = llmResponse.operations.length;
  } else {
    // --- Multiple chunks: sequential loop ---
    log('info', 'consolidation:phase', { phase: 'consolidate' });

    const chunkResults: ChunkResult[] = [];
    let totalPromptLength = 0;
    let totalOperationsRequested = 0;

    for (const chunk of chunkPlan.chunks) {
      // Check abort signal before each chunk
      if (signal.aborted) {
        log('info', 'consolidation:aborted', { phase: 'chunk-loop', chunkIndex: chunk.index });
        break;
      }

      const chunkPrompt = await buildChunkPrompt(
        config.memoryDirectory,
        config.sessionDirectory,
        chunk.memoryFiles,
        memories,
        chunk.index,
        chunkPlan.chunks.length,
        config,
        shared,
      );

      totalPromptLength += chunkPrompt.length;

      log('info', 'consolidation:chunk-llm-call', {
        chunkIndex: chunk.index,
        chunksTotal: chunkPlan.chunks.length,
        promptSize: chunkPrompt.length,
      });

      const llmResponse = await retryLlmCall(backend, chunkPrompt, 3, signal, llmOptions);
      result.chunksCompleted++;

      log('info', 'consolidation:llm-response', {
        chunkIndex: chunk.index,
        operationCount: llmResponse.operations.length,
        reasoning: llmResponse.reasoning,
      });

      totalOperationsRequested += llmResponse.operations.length;

      chunkResults.push({
        chunkIndex: chunk.index,
        operations: llmResponse.operations,
      });
    }

    result.promptLength = totalPromptLength;
    result.operationsRequested = totalOperationsRequested;

    if (signal.aborted) {
      log('info', 'consolidation:aborted', { phase: 'post-chunks' });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Merge chunk results and filter out index operations
    const mergedOps = mergeChunkResults(chunkResults);
    operations = mergedOps.filter((op) => op.path !== ENTRYPOINT_NAME);
  }

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

  // --- Phase 5: Orphan sweep ---
  // Remove .md files in the memory directory that are not referenced in the
  // updated index. This prevents stale files from accumulating when the LLM
  // merges content but forgets to emit delete operations. Pure filesystem
  // logic — no extra LLM calls or tokens.
  if (!config.dryRun && !signal.aborted) {
    const indexedFiles = new Set(updatedEntries.map((e) => e.file));
    const allFiles = await fs.readdir(config.memoryDirectory);
    for (const file of allFiles) {
      if (!file.endsWith('.md') || file === ENTRYPOINT_NAME) continue;
      if (!indexedFiles.has(file)) {
        try {
          await fs.unlink(path.join(config.memoryDirectory, file));
          result.orphansRemoved.push(file);
          log('info', 'consolidation:orphan-removed', { path: file });
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log('warn', 'consolidation:orphan-remove-failed', { path: file, reason: (err as Error).message });
          }
        }
      }
    }
  }

  log('info', 'consolidation:complete', {
    created: result.filesCreated.length,
    updated: result.filesUpdated.length,
    deleted: result.filesDeleted.length,
    orphansRemoved: result.orphansRemoved.length,
    indexUpdated: result.indexUpdated,
    truncationApplied: result.truncationApplied,
    durationMs: Date.now() - startTime,
    promptLength: result.promptLength,
    operationsRequested: result.operationsRequested,
    operationsApplied: result.operationsApplied,
    operationsSkipped: result.operationsSkipped,
    dryRun: config.dryRun,
    chunksTotal: result.chunksTotal,
    chunksCompleted: result.chunksCompleted,
  });

  result.durationMs = Date.now() - startTime;
  return result;
}
