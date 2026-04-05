import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { MemoryHeader, IndexEntry } from '../types.js';
import { formatMemoryManifest } from '../memory/memoryScanner.js';
import { formatIndexEntry } from '../memory/indexManager.js';

// --- Mocks ---

// Mock node:fs/promises to control filesystem reads
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

// Mock readIndex from indexManager (it reads from filesystem), but keep formatIndexEntry real
vi.mock('../memory/indexManager.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memory/indexManager.js')>();
  return {
    ...original,
    readIndex: vi.fn(),
  };
});

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

// Import after mocks are set up
import fs from 'node:fs/promises';
import { readIndex } from '../memory/indexManager.js';
import { buildChunkPrompt } from './promptBuilder.js';

const mockedFs = vi.mocked(fs);
const mockedReadIndex = vi.mocked(readIndex);

// --- Generators ---

/**
 * Generate a MemoryHeader with a unique, filesystem-safe path.
 * Uses a counter-based approach to ensure uniqueness.
 */
function makeMemoryHeaderArb(prefix: string): fc.Arbitrary<MemoryHeader> {
  return fc
    .record({
      name: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,9}$/),
      description: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,19}$/),
      type: fc.constantFrom('user' as const, 'project' as const, 'reference' as const, null),
    })
    .map(({ name, description, type }) => ({
      path: `${prefix}-${name}.md`,
      name,
      description,
      type,
      mtimeMs: Date.now(),
    }));
}

const indexEntryArb: fc.Arbitrary<IndexEntry> = fc
  .record({
    title: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,14}$/),
    file: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,9}$/).map((s) => `${s}.md`),
    description: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,19}$/),
  });

interface MockSession {
  name: string;
  content: string;
}

const sessionArb: fc.Arbitrary<MockSession> = fc
  .record({
    name: fc.stringMatching(/^sess[a-zA-Z0-9]{1,8}$/).map((s) => `${s}.md`),
    content: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{4,49}$/),
  });

// --- Helpers ---

const MEMORY_DIR = '/fake/memory';
const SESSION_DIR = '/fake/sessions';

function setupMocks(
  indexEntries: IndexEntry[],
  sessions: MockSession[],
  memoryContents: Map<string, string>,
): void {
  mockedReadIndex.mockResolvedValue(indexEntries);

  // readdir returns session file names
  mockedFs.readdir.mockResolvedValue(sessions.map((s) => s.name) as any);

  // stat returns file-like stats
  mockedFs.stat.mockResolvedValue({
    isDirectory: () => false,
    mtimeMs: Date.now(),
  } as any);

  // readFile dispatches based on directory prefix in the path
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath);

    // Session files live under SESSION_DIR
    if (p.startsWith(SESSION_DIR)) {
      for (const session of sessions) {
        if (p.endsWith(`/${session.name}`)) return session.content;
      }
    }

    // Memory files live under MEMORY_DIR
    if (p.startsWith(MEMORY_DIR)) {
      for (const [memPath, content] of memoryContents.entries()) {
        if (p.endsWith(`/${memPath}`)) return content;
      }
    }

    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

// Feature: batch-consolidation, Property 6: Chunk prompt shared context
describe('Property 6: Chunk prompt contains full shared context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 8.1, 8.2, 8.4, 1.4**
   *
   * For any non-empty set of memory headers, index entries, and session files,
   * every chunk prompt produced by buildChunkPrompt should contain:
   * (a) the full memory manifest listing all memory file names,
   * (b) the full MEMORY.md index content,
   * (c) all session file content.
   */
  it('every chunk prompt contains full manifest, full index, and all sessions', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 2-6 memory headers
        fc.array(makeMemoryHeaderArb('mem'), { minLength: 2, maxLength: 6 }),
        // Generate 1-3 index entries
        fc.array(indexEntryArb, { minLength: 1, maxLength: 3 }),
        // Generate 1-3 sessions
        fc.array(sessionArb, { minLength: 1, maxLength: 3 }),
        async (allMemories, indexEntries, sessions) => {
          // Deduplicate by path/name
          const seenPaths = new Set<string>();
          const uniqueMemories = allMemories.filter((m) => {
            if (seenPaths.has(m.path)) return false;
            seenPaths.add(m.path);
            return true;
          });
          if (uniqueMemories.length < 2) return;

          const seenSessionNames = new Set<string>();
          const uniqueSessions = sessions.filter((s) => {
            if (seenSessionNames.has(s.name)) return false;
            seenSessionNames.add(s.name);
            return true;
          });
          if (uniqueSessions.length === 0) return;

          // Create memory file contents
          const memoryContents = new Map<string, string>();
          for (const mem of uniqueMemories) {
            memoryContents.set(
              mem.path,
              `---\nname: "${mem.name}"\ndescription: "${mem.description}"\ntype: ${mem.type ?? 'project'}\n---\nContent of ${mem.name}`,
            );
          }

          // Split memories into 2 chunks
          const mid = Math.ceil(uniqueMemories.length / 2);
          const chunk0Memories = uniqueMemories.slice(0, mid);
          const chunk1Memories = uniqueMemories.slice(mid);
          const chunksTotal = 2;

          // Build prompt for chunk 0
          setupMocks(indexEntries, uniqueSessions, memoryContents);
          const prompt0 = await buildChunkPrompt(
            MEMORY_DIR,
            SESSION_DIR,
            chunk0Memories,
            uniqueMemories,
            0,
            chunksTotal,
          );

          // Build prompt for chunk 1
          setupMocks(indexEntries, uniqueSessions, memoryContents);
          const prompt1 = await buildChunkPrompt(
            MEMORY_DIR,
            SESSION_DIR,
            chunk1Memories,
            uniqueMemories,
            1,
            chunksTotal,
          );

          // Expected manifest lines (from formatMemoryManifest applied to ALL memories)
          const manifestLines = formatMemoryManifest(uniqueMemories)
            .split('\n')
            .filter((l) => l.trim());

          // Expected index lines
          const expectedIndexLines = indexEntries.map(formatIndexEntry);

          // (a) Both prompts contain full manifest
          for (const line of manifestLines) {
            expect(prompt0).toContain(line);
            expect(prompt1).toContain(line);
          }

          // (b) Both prompts contain full index
          for (const indexLine of expectedIndexLines) {
            expect(prompt0).toContain(indexLine);
            expect(prompt1).toContain(indexLine);
          }

          // (c) Both prompts contain all session content
          for (const session of uniqueSessions) {
            expect(prompt0).toContain(session.content);
            expect(prompt1).toContain(session.content);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: batch-consolidation, Property 7: Chunk prompt content isolation
describe('Property 7: Chunk prompt content isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 8.3**
   *
   * For any multi-chunk plan, each chunk prompt produced by buildChunkPrompt
   * should contain the full content of every memory file assigned to that chunk,
   * and should not contain the full content of any memory file assigned to a
   * different chunk.
   */
  it('each chunk prompt contains only its assigned files content', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 4-8 memory headers
        fc.array(makeMemoryHeaderArb('iso'), { minLength: 4, maxLength: 8 }),
        // Generate 1-2 index entries
        fc.array(indexEntryArb, { minLength: 1, maxLength: 2 }),
        // Generate 1-2 sessions
        fc.array(sessionArb, { minLength: 1, maxLength: 2 }),
        // Random suffix to make content markers unique per run
        fc.stringMatching(/^[A-Z]{6}$/),
        async (allMemories, indexEntries, sessions, randomSuffix) => {
          // Deduplicate by path
          const seenPaths = new Set<string>();
          const uniqueMemories = allMemories.filter((m) => {
            if (seenPaths.has(m.path)) return false;
            seenPaths.add(m.path);
            return true;
          });
          if (uniqueMemories.length < 4) return;

          const seenSessionNames = new Set<string>();
          const uniqueSessions = sessions.filter((s) => {
            if (seenSessionNames.has(s.name)) return false;
            seenSessionNames.add(s.name);
            return true;
          });
          if (uniqueSessions.length === 0) return;

          // Create memory file contents with unique isolation markers
          const memoryContents = new Map<string, string>();
          const contentMarkers = new Map<string, string>();
          for (const mem of uniqueMemories) {
            const marker = `CHUNK_ISOLATION_MARKER_${mem.name}_${randomSuffix}`;
            contentMarkers.set(mem.path, marker);
            memoryContents.set(
              mem.path,
              `---\nname: "${mem.name}"\ndescription: "${mem.description}"\ntype: ${mem.type ?? 'project'}\n---\n${marker}`,
            );
          }

          // Split into 2 chunks (first half, second half)
          const mid = Math.ceil(uniqueMemories.length / 2);
          const chunk0Memories = uniqueMemories.slice(0, mid);
          const chunk1Memories = uniqueMemories.slice(mid);
          const chunksTotal = 2;

          // Build prompt for chunk 0
          setupMocks(indexEntries, uniqueSessions, memoryContents);
          const prompt0 = await buildChunkPrompt(
            MEMORY_DIR,
            SESSION_DIR,
            chunk0Memories,
            uniqueMemories,
            0,
            chunksTotal,
          );

          // Build prompt for chunk 1
          setupMocks(indexEntries, uniqueSessions, memoryContents);
          const prompt1 = await buildChunkPrompt(
            MEMORY_DIR,
            SESSION_DIR,
            chunk1Memories,
            uniqueMemories,
            1,
            chunksTotal,
          );

          // Chunk 0 prompt: CONTAINS its own markers, does NOT contain chunk 1 markers
          for (const mem of chunk0Memories) {
            const marker = contentMarkers.get(mem.path)!;
            expect(prompt0).toContain(marker);
          }
          for (const mem of chunk1Memories) {
            const marker = contentMarkers.get(mem.path)!;
            expect(prompt0).not.toContain(marker);
          }

          // Chunk 1 prompt: CONTAINS its own markers, does NOT contain chunk 0 markers
          for (const mem of chunk1Memories) {
            const marker = contentMarkers.get(mem.path)!;
            expect(prompt1).toContain(marker);
          }
          for (const mem of chunk0Memories) {
            const marker = contentMarkers.get(mem.path)!;
            expect(prompt1).not.toContain(marker);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// Feature: batch-consolidation, Property 8: Chunk prompt context header
describe('Property 8: Chunk prompt context header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 8.5**
   *
   * For any chunk in a multi-chunk plan, the prompt produced by buildChunkPrompt
   * should contain a context header that includes the 1-based chunk index, the
   * total chunk count, and the names of the memory files included in that chunk.
   */
  it('every chunk prompt contains chunk index, total, and file names in context header', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 3-8 memory headers
        fc.array(makeMemoryHeaderArb('hdr'), { minLength: 3, maxLength: 8 }),
        // Generate 1-2 index entries
        fc.array(indexEntryArb, { minLength: 1, maxLength: 2 }),
        // Generate 1-2 sessions
        fc.array(sessionArb, { minLength: 1, maxLength: 2 }),
        // Random chunksTotal between 2 and 5
        fc.integer({ min: 2, max: 5 }),
        async (allMemories, indexEntries, sessions, chunksTotal) => {
          // Deduplicate memories by path
          const seenPaths = new Set<string>();
          const uniqueMemories = allMemories.filter((m) => {
            if (seenPaths.has(m.path)) return false;
            seenPaths.add(m.path);
            return true;
          });
          if (uniqueMemories.length < 2) return;

          const seenSessionNames = new Set<string>();
          const uniqueSessions = sessions.filter((s) => {
            if (seenSessionNames.has(s.name)) return false;
            seenSessionNames.add(s.name);
            return true;
          });
          if (uniqueSessions.length === 0) return;

          // Create memory file contents
          const memoryContents = new Map<string, string>();
          for (const mem of uniqueMemories) {
            memoryContents.set(
              mem.path,
              `---\nname: "${mem.name}"\ndescription: "${mem.description}"\ntype: ${mem.type ?? 'project'}\n---\nContent of ${mem.name}`,
            );
          }

          // Split memories into chunks (distribute evenly)
          const chunkSize = Math.max(1, Math.ceil(uniqueMemories.length / chunksTotal));
          const chunks: MemoryHeader[][] = [];
          for (let i = 0; i < chunksTotal; i++) {
            const start = i * chunkSize;
            const slice = uniqueMemories.slice(start, start + chunkSize);
            if (slice.length > 0) {
              chunks.push(slice);
            }
          }
          const actualChunksTotal = chunks.length;
          if (actualChunksTotal < 2) return;

          // Pick a random chunk index to test
          const chunkIndex = Math.floor(Math.random() * actualChunksTotal);
          const chunkMemories = chunks[chunkIndex];

          setupMocks(indexEntries, uniqueSessions, memoryContents);
          const prompt = await buildChunkPrompt(
            MEMORY_DIR,
            SESSION_DIR,
            chunkMemories,
            uniqueMemories,
            chunkIndex,
            actualChunksTotal,
          );

          // (a) Prompt contains the 1-based chunk index
          const displayIndex = chunkIndex + 1;
          expect(prompt).toContain(`Processing chunk ${displayIndex} of ${actualChunksTotal}`);

          // (b) Prompt contains the total chunk count (already verified above in the same string)

          // (c) Prompt contains the file names/paths of memory files in this chunk
          const expectedFileList = chunkMemories.map((m) => m.path).join(', ');
          expect(prompt).toContain(`This chunk contains: ${expectedFileList}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
