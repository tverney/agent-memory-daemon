import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';
import { scanMemoryFiles, formatMemoryManifest } from '../memory/memoryScanner.js';
import { readIndex, formatIndexEntry } from '../memory/indexManager.js';
import { memoryAge, memoryFreshnessText } from '../memory/memoryAge.js';
import type { MemoryHeader, IndexEntry, MemconsolidateConfig } from '../types.js';

interface SessionFile {
  name: string;
  mtimeMs: number;
  content: string;
}

interface MemoryFileContent {
  header: MemoryHeader;
  content: string;
}

// Default caps (used when no config is provided)
const DEFAULT_MAX_MEMORY_CONTENT_CHARS = 4000;
const DEFAULT_MAX_SESSION_CONTENT_CHARS = 2000;

/**
 * Read the full content of each memory file.
 * Returns files with their content, capped at MAX_MEMORY_CONTENT_CHARS each.
 */
async function readMemoryFileContents(
  memoryDir: string,
  memories: MemoryHeader[],
): Promise<MemoryFileContent[]> {
  const results = await Promise.all(
    memories.map(async (header) => {
      try {
        const filePath = path.join(memoryDir, header.path);
        const content = await fs.readFile(filePath, 'utf-8');
        return { header, content };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is MemoryFileContent => r !== null);
}

/**
 * Read recent session files from the session directory.
 * Supports plain text (.md, .txt) and JSONL (.jsonl) formats.
 * Returns files with content, sorted newest-first, capped at 20.
 */
async function readRecentSessions(sessionDir: string): Promise<SessionFile[]> {
  try {
    const entries = await fs.readdir(sessionDir);
    const files = await Promise.all(
      entries.map(async (name) => {
        try {
          const filePath = path.join(sessionDir, name);
          const [stat, rawContent] = await Promise.all([
            fs.stat(filePath),
            fs.readFile(filePath, 'utf-8'),
          ]);
          // Skip directories
          if (stat.isDirectory()) return null;

          const content = name.endsWith('.jsonl')
            ? extractJsonlContent(rawContent)
            : rawContent;

          return { name, mtimeMs: stat.mtimeMs, content };
        } catch {
          return null;
        }
      }),
    );
    return files
      .filter((s): s is SessionFile => s !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 20);
  } catch {
    log('warn', 'prompt:session-dir-read-failed', { sessionDir });
    return [];
  }
}

/**
 * Extract human-readable content from JSONL session transcripts.
 * Looks for common patterns: { role, content }, { type, text }, { message }.
 * Falls back to raw text if parsing fails.
 */
function extractJsonlContent(raw: string): string {
  const lines = raw.split('\n').filter((l) => l.trim());
  const extracted: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // Common transcript formats
      if (typeof obj.content === 'string') {
        const role = typeof obj.role === 'string' ? `[${obj.role}] ` : '';
        extracted.push(`${role}${obj.content}`);
      } else if (typeof obj.text === 'string') {
        extracted.push(obj.text);
      } else if (typeof obj.message === 'string') {
        extracted.push(obj.message);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  return extracted.length > 0 ? extracted.join('\n') : raw;
}

/**
 * Build staleness caveats for memory files older than 1 day.
 */
function buildStalenessCaveats(memories: MemoryHeader[]): string {
  const stale = memories.filter((m) => Date.now() - m.mtimeMs > 86_400_000);
  if (stale.length === 0) return '';

  const lines = stale.map(
    (m) => `- ${m.path} (${m.name}): ${memoryFreshnessText(m.mtimeMs)}`,
  );
  return `\n## Staleness Caveats\n\nThe following memories are older than 1 day. Treat them as point-in-time observations that may be outdated:\n\n${lines.join('\n')}\n`;
}

/**
 * Build a self-contained 4-phase consolidation prompt from current memory state.
 *
 * The prompt instructs the LLM to:
 * - Phase 1 (Orient): understand current memory state
 * - Phase 2 (Gather): identify new information from recent files and sessions
 * - Phase 3 (Consolidate): merge, update, convert dates, delete contradicted facts
 * - Phase 4 (Prune): update index, enforce size budget, remove stale entries
 *
 * @param memoryDir - Path to the memory directory
 * @param sessionDir - Path to the session directory
 * @param extraContext - Optional additional context to include in the prompt
 */
export async function buildConsolidationPrompt(
  memoryDir: string,
  sessionDir: string,
  extraContext?: string,
  config?: MemconsolidateConfig,
): Promise<string> {
  const maxMemoryChars = config?.maxMemoryContentChars ?? DEFAULT_MAX_MEMORY_CONTENT_CHARS;
  const maxSessionChars = config?.maxSessionContentChars ?? DEFAULT_MAX_SESSION_CONTENT_CHARS;

  // Gather current state
  const [memories, indexEntries, sessions] = await Promise.all([
    scanMemoryFiles(memoryDir),
    readIndex(memoryDir),
    readRecentSessions(sessionDir),
  ]);

  // Read full content of memory files so the LLM can make informed decisions
  const memoryContents = await readMemoryFileContents(memoryDir, memories);

  const manifest = formatMemoryManifest(memories);
  const indexContent = indexEntries.map(formatIndexEntry).join('\n');
  const stalenessCaveats = buildStalenessCaveats(memories);
  const today = new Date().toISOString().slice(0, 10);

  const sections: string[] = [
    buildPreamble(today, memories.length, indexEntries.length, sessions.length),
    buildCurrentState(manifest, indexContent),
    buildMemoryFileContents(memoryContents, maxMemoryChars),
    stalenessCaveats,
    buildSessionInfo(sessions, maxSessionChars),
    extraContext ? `\n## Additional Context\n\n${extraContext}\n` : '',
    buildPhaseInstructions(today),
    buildResponseFormat(),
  ];

  const prompt = sections.filter(Boolean).join('\n');
  log('info', 'prompt:built', {
    memoryFiles: memories.length,
    indexEntries: indexEntries.length,
    sessions: sessions.length,
    promptLength: prompt.length,
  });

  return prompt;
}

function buildPreamble(
  today: string,
  memoryCount: number,
  indexCount: number,
  sessionCount: number,
): string {
  return `# Memory Consolidation Task

You are a memory consolidation agent. Your job is to organize, merge, and maintain a set of markdown memory files.

Today's date: ${today}
Memory files found: ${memoryCount}
Index entries: ${indexCount}
Recent sessions: ${sessionCount}

You will execute a four-phase consolidation pass: Orient → Gather → Consolidate → Prune.
Return your changes as a JSON object containing file operations.`;
}

function buildCurrentState(manifest: string, indexContent: string): string {
  let section = '\n## Current Memory State\n';

  if (manifest) {
    section += `\n### Memory File Manifest\n\n${manifest}\n`;
  } else {
    section += '\n### Memory File Manifest\n\nNo memory files found.\n';
  }

  if (indexContent) {
    section += `\n### Current Index (MEMORY.md)\n\n${indexContent}\n`;
  } else {
    section += '\n### Current Index (MEMORY.md)\n\nIndex is empty.\n';
  }

  return section;
}

function buildMemoryFileContents(memoryContents: MemoryFileContent[], maxChars: number): string {
  if (memoryContents.length === 0) return '';

  const blocks = memoryContents.map((m) => {
    const trimmed =
      m.content.length > maxChars
        ? m.content.slice(0, maxChars) + '\n... (truncated)'
        : m.content;
    return `### ${m.header.path}\n\n\`\`\`markdown\n${trimmed}\n\`\`\``;
  });

  return `\n## Existing Memory File Contents\n\nFull content of each memory file for reference when merging, updating, or deduplicating:\n\n${blocks.join('\n\n')}\n`;
}

function buildSessionInfo(sessions: SessionFile[], maxChars: number): string {
  if (sessions.length === 0) return '';

  const blocks = sessions.map((s) => {
    const trimmed =
      s.content.length > maxChars
        ? s.content.slice(0, maxChars) + '\n... (truncated)'
        : s.content;
    return `### ${s.name}\n\n${trimmed}`;
  });

  return `\n## Recent Session Contents\n\nThe following session files contain new information to consider for consolidation:\n\n${blocks.join('\n\n')}\n`;
}

function buildPhaseInstructions(today: string): string {
  return `
## Instructions

Execute the following four phases in order:

### Phase 1: Orient

Review the memory file manifest and current index above. Understand:
- What topics are already covered
- Which files are recent vs. stale
- What the current index looks like

### Phase 2: Gather

Identify new information that should be consolidated:
- Recently modified memory files may contain new observations
- Session files may reference new facts, decisions, or corrections
- Look for duplicate or overlapping topics that should be merged

### Phase 3: Consolidate

Apply changes to memory files:
- Merge new observations into existing topic-matched files rather than creating near-duplicates
- Convert ALL relative date references to absolute dates using today's date (${today}). Examples:
  - "yesterday" → the date that was yesterday relative to ${today}
  - "last week" → the approximate date
  - "recently" → include the actual date if known
- Delete or correct facts that are contradicted by newer observations
- Organize files semantically by topic, not chronologically
- Every created or updated file MUST have valid YAML frontmatter with name, description, and type fields
- Valid types are: user, feedback, project, reference

### Phase 4: Prune

Update the MEMORY.md index:
- Add entries for newly created files
- Update entries for modified files
- Remove entries for deleted files
- Each index line must follow the format: \`- [Title](file.md) — one-line description\`
- Each line must be under 150 characters
- The total index must stay under 200 lines and 25 KB
- Demote verbose entries (over 200 characters) by shortening them
- Remove entries pointing to files that no longer exist`;
}

function buildResponseFormat(): string {
  return `
## Response Format

Return a JSON object with this exact structure:

\`\`\`json
{
  "operations": [
    {
      "op": "create",
      "path": "filename.md",
      "content": "---\\nname: \\"Title\\"\\ndescription: \\"Description\\"\\ntype: project\\n---\\nBody content..."
    },
    {
      "op": "update",
      "path": "existing-file.md",
      "content": "---\\nname: \\"Title\\"\\ndescription: \\"Updated description\\"\\ntype: reference\\n---\\nUpdated body..."
    },
    {
      "op": "delete",
      "path": "obsolete-file.md"
    }
  ],
  "reasoning": "Brief explanation of what was consolidated and why"
}
\`\`\`

Rules:
- "path" is relative to the memory directory (just the filename, e.g. "my-topic.md")
- "content" is required for "create" and "update" operations
- "content" MUST include valid YAML frontmatter with name, description, and type fields
- Do NOT include MEMORY.md in operations — index updates are handled separately
- Return an empty operations array if no changes are needed
- Return ONLY the JSON object, no other text`;
}
