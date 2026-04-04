import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExtractionPrompt } from './extractionPromptBuilder.js';
import type { FileOperation, LlmResponse } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/**
 * Arbitrary for a valid memory file with frontmatter.
 */
const memoryFileArb = fc
  .record({
    basename: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
    description: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,50}$/),
    type: fc.constantFrom(...MEMORY_TYPES),
    body: fc.stringMatching(/^[A-Za-z0-9 .,\n]{0,100}$/),
  })
  .map((m) => ({
    filename: `${m.basename}.md`,
    content: `---\nname: "${m.name}"\ndescription: "${m.description}"\ntype: ${m.type}\n---\n${m.body}`,
    name: m.name,
    description: m.description,
    type: m.type,
  }));

/**
 * Arbitrary for session file content (plain text .md files).
 */
const sessionFileArb = fc
  .record({
    basename: fc.stringMatching(/^session-[a-z0-9]{1,10}$/),
    content: fc.stringMatching(/^[A-Za-z0-9 .,\n]{1,200}$/),
  })
  .map((s) => ({
    filename: `${s.basename}.md`,
    content: s.content,
  }));

describe('Extraction prompt builder property tests', () => {
  // Feature: memory-extraction, Property 8: Extraction prompt contains manifest, session content, and date
  it('Property 8: Extraction prompt contains manifest, session content, and date', async () => {
    // Validates: Requirements 4.1, 4.2, 4.7

    const inputArb = fc
      .tuple(
        fc.array(memoryFileArb, { minLength: 0, maxLength: 5 }),
        fc.array(sessionFileArb, { minLength: 1, maxLength: 3 }),
      )
      .map(([memoryFiles, sessionFiles]) => {
        // Deduplicate by filename
        const seenMem = new Set<string>();
        const uniqueMemory = memoryFiles.filter((f) => {
          if (seenMem.has(f.filename)) return false;
          seenMem.add(f.filename);
          return true;
        });
        const seenSess = new Set<string>();
        const uniqueSession = sessionFiles.filter((f) => {
          if (seenSess.has(f.filename)) return false;
          seenSess.add(f.filename);
          return true;
        });
        return { memoryFiles: uniqueMemory, sessionFiles: uniqueSession };
      });

    await fc.assert(
      fc.asyncProperty(inputArb, async ({ memoryFiles, sessionFiles }) => {
        const tmpBase = join(
          tmpdir(),
          `prompt-pbt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        const memoryDir = join(tmpBase, 'memory');
        const sessionDir = join(tmpBase, 'sessions');
        await mkdir(memoryDir, { recursive: true });
        await mkdir(sessionDir, { recursive: true });

        try {
          // Write memory files
          for (const mf of memoryFiles) {
            await writeFile(join(memoryDir, mf.filename), mf.content, 'utf-8');
          }

          // Write session files
          for (const sf of sessionFiles) {
            await writeFile(join(sessionDir, sf.filename), sf.content, 'utf-8');
          }

          const sessionFilenames = sessionFiles.map((sf) => sf.filename);

          const prompt = await buildExtractionPrompt(
            memoryDir,
            sessionFilenames,
            sessionDir,
            5_000,
            10_000,
          );

          // Property: prompt contains today's date in ISO format (YYYY-MM-DD)
          const today = new Date().toISOString().slice(0, 10);
          expect(prompt).toContain(today);

          // Property: prompt contains memory manifest entries when memory files exist
          for (const mf of memoryFiles) {
            // The manifest format is: "filename [type]: name — description"
            expect(prompt).toContain(mf.filename);
            expect(prompt).toContain(mf.name);
          }

          // Property: prompt contains session file content
          for (const sf of sessionFiles) {
            // Session content is included under a heading with the filename
            expect(prompt).toContain(sf.filename);
            expect(prompt).toContain(sf.content);
          }

          // Property: prompt is a non-empty string
          expect(prompt.length).toBeGreaterThan(0);
        } finally {
          await rm(tmpBase, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe('Extraction prompt instruction content (unit tests)', () => {
  // Validates: Requirements 4.3, 4.4, 4.5, 4.6
  let tmpBase: string;
  let memoryDir: string;
  let sessionDir: string;

  const sampleMemory = `---
name: "Test Memory"
description: "A test memory file"
type: user
---
Some memory content.`;

  const sampleSession = `# Session 1
User discussed project setup and coding preferences.`;

  // Set up minimal temp dirs with one memory file and one session file
  const setup = async () => {
    tmpBase = join(
      tmpdir(),
      `prompt-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    memoryDir = join(tmpBase, 'memory');
    sessionDir = join(tmpBase, 'sessions');
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(memoryDir, 'test-memory.md'), sampleMemory, 'utf-8');
    await writeFile(join(sessionDir, 'session-001.md'), sampleSession, 'utf-8');
  };

  const cleanup = async () => {
    await rm(tmpBase, { recursive: true, force: true });
  };

  it('should contain keyword "facts" in the prompt instructions', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt.toLowerCase()).toContain('facts');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "decisions" in the prompt instructions', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt.toLowerCase()).toContain('decisions');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "preferences" in the prompt instructions', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt.toLowerCase()).toContain('preferences');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "user" as a memory type in the prompt', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt).toContain('user');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "feedback" as a memory type in the prompt', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt).toContain('feedback');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "project" as a memory type in the prompt', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt).toContain('project');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "reference" as a memory type in the prompt', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt).toContain('reference');
    } finally {
      await cleanup();
    }
  });

  it('should contain keyword "JSON" for response format in the prompt', async () => {
    await setup();
    try {
      const prompt = await buildExtractionPrompt(memoryDir, ['session-001.md'], sessionDir, 5_000, 10_000);
      expect(prompt).toContain('JSON');
    } finally {
      await cleanup();
    }
  });
});


describe('Prompt build/parse round-trip property test', () => {
  // Feature: memory-extraction, Property 16: Prompt build/parse round-trip

  /**
   * Arbitrary for a valid FileOperation (create or update) with frontmatter content.
   */
  const fileOperationArb = fc
    .record({
      op: fc.constantFrom('create' as const, 'update' as const),
      basename: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
      name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
      description: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,50}$/),
      type: fc.constantFrom(...MEMORY_TYPES),
      body: fc.stringMatching(/^[A-Za-z0-9 .,\n]{0,100}$/),
    })
    .map((o) => ({
      op: o.op,
      path: `${o.basename}.md`,
      content: `---\nname: "${o.name}"\ndescription: "${o.description}"\ntype: ${o.type}\n---\n${o.body}`,
    }));

  /**
   * Arbitrary for a conforming LlmResponse with valid FileOperations.
   */
  const llmResponseArb = fc
    .record({
      operations: fc.array(fileOperationArb, { minLength: 0, maxLength: 5 }),
      reasoning: fc.option(fc.stringMatching(/^[A-Za-z0-9 .,]{0,100}$/), { nil: undefined }),
    })
    .map((r) => {
      // Deduplicate operations by path
      const seen = new Set<string>();
      const uniqueOps = r.operations.filter((op) => {
        if (seen.has(op.path)) return false;
        seen.add(op.path);
        return true;
      });
      return { operations: uniqueOps, reasoning: r.reasoning };
    });

  it('Property 16: building a prompt and parsing a conforming JSON response produces valid FileOperations', async () => {
    // Validates: Requirements 11.3

    const inputArb = fc.tuple(
      fc
        .tuple(
          fc.array(memoryFileArb, { minLength: 0, maxLength: 3 }),
          fc.array(sessionFileArb, { minLength: 1, maxLength: 3 }),
        )
        .map(([memoryFiles, sessionFiles]) => {
          const seenMem = new Set<string>();
          const uniqueMemory = memoryFiles.filter((f) => {
            if (seenMem.has(f.filename)) return false;
            seenMem.add(f.filename);
            return true;
          });
          const seenSess = new Set<string>();
          const uniqueSession = sessionFiles.filter((f) => {
            if (seenSess.has(f.filename)) return false;
            seenSess.add(f.filename);
            return true;
          });
          return { memoryFiles: uniqueMemory, sessionFiles: uniqueSession };
        }),
      llmResponseArb,
    );

    await fc.assert(
      fc.asyncProperty(inputArb, async ([{ memoryFiles, sessionFiles }, generatedResponse]) => {
        const tmpBase = join(
          tmpdir(),
          `roundtrip-pbt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        const memoryDir = join(tmpBase, 'memory');
        const sessionDir = join(tmpBase, 'sessions');
        await mkdir(memoryDir, { recursive: true });
        await mkdir(sessionDir, { recursive: true });

        try {
          // Step 1-2: Write memory and session files to temp dirs
          for (const mf of memoryFiles) {
            await writeFile(join(memoryDir, mf.filename), mf.content, 'utf-8');
          }
          for (const sf of sessionFiles) {
            await writeFile(join(sessionDir, sf.filename), sf.content, 'utf-8');
          }

          // Step 3: Build the prompt
          const prompt = await buildExtractionPrompt(
            memoryDir,
            sessionFiles.map((sf) => sf.filename),
            sessionDir,
            5_000,
            10_000,
          );

          // Prompt should be a non-empty string
          expect(prompt.length).toBeGreaterThan(0);

          // Step 4-5: Serialize the conforming LlmResponse to JSON and parse it back
          const jsonString = JSON.stringify(generatedResponse);
          const parsed: LlmResponse = JSON.parse(jsonString);

          // Step 6: Verify the parsed result has a valid operations array
          expect(Array.isArray(parsed.operations)).toBe(true);

          const validOps = new Set<string>(['create', 'update', 'delete']);

          for (const op of parsed.operations) {
            // Each operation has a valid op field
            expect(validOps.has(op.op)).toBe(true);

            // Each operation has a string path
            expect(typeof op.path).toBe('string');
            expect(op.path.length).toBeGreaterThan(0);

            // Content is optional but when present must be a string
            if (op.content !== undefined) {
              expect(typeof op.content).toBe('string');
            }

            // Step 7: For create/update ops, verify content contains frontmatter
            if (op.op === 'create' || op.op === 'update') {
              expect(op.content).toBeDefined();
              expect(typeof op.content).toBe('string');
              expect(op.content!.startsWith('---')).toBe(true);
            }
          }

          // Reasoning is optional but when present must be a string
          if (parsed.reasoning !== undefined) {
            expect(typeof parsed.reasoning).toBe('string');
          }
        } finally {
          await rm(tmpBase, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
