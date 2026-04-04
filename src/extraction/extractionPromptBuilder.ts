import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';
import { scanMemoryFiles, formatMemoryManifest } from '../memory/memoryScanner.js';

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
 * Read a single session file, returning its content as a string.
 * Supports .md, .txt (plain text) and .jsonl (extract human-readable content).
 * Returns null if the file cannot be read.
 */
async function readSessionFile(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return filePath.endsWith('.jsonl') ? extractJsonlContent(raw) : raw;
  } catch {
    log('warn', 'extraction-prompt:session-read-failed', { file: filePath });
    return null;
  }
}

/**
 * Build a self-contained extraction prompt from current memory state and modified session files.
 *
 * The prompt instructs the LLM to:
 * - Review the memory manifest to understand what already exists
 * - Read modified session content to identify new facts, decisions, preferences, and error corrections
 * - Create or update memory files, classifying each with a memory type
 * - Return JSON { operations, reasoning } in the same format as consolidation
 *
 * @param memoryDir - Path to the memory directory
 * @param sessionFiles - Paths to modified session files (relative to sessionDir)
 * @param sessionDir - Path to the session directory
 * @param maxSessionChars - Maximum characters to include per session file
 * @param maxMemoryChars - Maximum total characters for the memory manifest section
 */
export async function buildExtractionPrompt(
  memoryDir: string,
  sessionFiles: string[],
  sessionDir: string,
  maxSessionChars: number,
  maxMemoryChars: number,
): Promise<string> {
  // Gather memory manifest
  const memories = await scanMemoryFiles(memoryDir);
  let manifest = formatMemoryManifest(memories);
  if (manifest.length > maxMemoryChars) {
    manifest = manifest.slice(0, maxMemoryChars) + '\n... (truncated)';
  }

  // Read modified session files
  const sessionBlocks: string[] = [];
  for (const file of sessionFiles) {
    const filePath = path.join(sessionDir, file);
    const content = await readSessionFile(filePath);
    if (content === null) continue;

    const trimmed =
      content.length > maxSessionChars
        ? content.slice(0, maxSessionChars) + '\n... (truncated)'
        : content;
    sessionBlocks.push(`### ${file}\n\n${trimmed}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  const sections: string[] = [
    buildPreamble(today, memories.length, sessionFiles.length),
    buildManifestSection(manifest),
    buildSessionSection(sessionBlocks),
    buildInstructions(today),
    buildResponseFormat(),
  ];

  const prompt = sections.filter(Boolean).join('\n');

  log('info', 'extraction-prompt:built', {
    memoryFiles: memories.length,
    sessionFiles: sessionFiles.length,
    promptLength: prompt.length,
  });

  return prompt;
}

function buildPreamble(
  today: string,
  memoryCount: number,
  sessionCount: number,
): string {
  return `# Memory Extraction Task

You are a memory extraction agent. Your job is to identify important facts, decisions, user preferences, and error corrections from recent session transcripts and write them as individual memory files.

Today's date: ${today}
Existing memory files: ${memoryCount}
Modified session files to analyze: ${sessionCount}

Review the existing memory manifest below, then analyze the session content to extract new memories.
Return your changes as a JSON object containing file operations.`;
}

function buildManifestSection(manifest: string): string {
  if (!manifest) {
    return '\n## Existing Memory Manifest\n\nNo existing memory files found.\n';
  }
  return `\n## Existing Memory Manifest\n\nThese memory files already exist. Check this manifest before creating new files to avoid duplicates. If a topic overlaps with an existing file, update that file instead of creating a new one.\n\n${manifest}\n`;
}

function buildSessionSection(sessionBlocks: string[]): string {
  if (sessionBlocks.length === 0) {
    return '\n## Modified Session Content\n\nNo session content available.\n';
  }
  return `\n## Modified Session Content\n\nAnalyze the following session transcripts for facts, decisions, preferences, and error corrections worth remembering:\n\n${sessionBlocks.join('\n\n')}\n`;
}

function buildInstructions(today: string): string {
  return `
## Instructions

Extract new memories from the session content above:

1. **Identify** facts, decisions, user preferences, and error corrections worth remembering long-term.
   - Facts: technical details, API behaviors, configuration values, environment specifics
   - Decisions: architectural choices, tool selections, design patterns adopted
   - Preferences: coding style, editor settings, workflow habits, communication preferences
   - Error corrections: bugs found, incorrect assumptions corrected, lessons learned

2. **Check the manifest** before creating new files. If an existing memory file covers the same topic, use an "update" operation to add the new information to that file instead of creating a duplicate.

3. **Classify** each memory using one of these types:
   - \`user\` — personal preferences, habits, workflow choices
   - \`feedback\` — error corrections, lessons learned, bugs encountered
   - \`project\` — architecture decisions, project setup, build configuration
   - \`reference\` — technical facts, API details, environment information

4. **Convert relative dates** to absolute dates using today's date (${today}). For example:
   - "yesterday" → the date that was yesterday relative to ${today}
   - "last week" → the approximate date range
   - "recently" → include the actual date if known

5. **Write concise memories**. Each memory file should focus on a single topic. Keep content factual and actionable.

6. Every created or updated file MUST have valid YAML frontmatter with \`name\`, \`description\`, and \`type\` fields.`;
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
      "path": "descriptive-filename.md",
      "content": "---\\nname: \\"Title\\"\\ndescription: \\"One-line description\\"\\ntype: user\\n---\\nBody content..."
    },
    {
      "op": "update",
      "path": "existing-file.md",
      "content": "---\\nname: \\"Title\\"\\ndescription: \\"Updated description\\"\\ntype: reference\\n---\\nUpdated body..."
    }
  ],
  "reasoning": "Brief explanation of what was extracted and why"
}
\`\`\`

Rules:
- "path" is relative to the memory directory (just the filename, e.g. "my-topic.md")
- "content" is required for "create" and "update" operations
- "content" MUST include valid YAML frontmatter with name, description, and type fields
- Do NOT include MEMORY.md in operations — index updates are handled separately
- Return an empty operations array if no new memories are worth extracting
- Return ONLY the JSON object, no other text`;
}
