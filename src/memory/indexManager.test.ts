import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatIndexEntry,
  readIndex,
  writeIndex,
  truncateIndexContent,
  ENTRYPOINT_NAME,
} from './indexManager.js';
import type { IndexEntry } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `indexmgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatIndexEntry
// ---------------------------------------------------------------------------
describe('formatIndexEntry', () => {
  it('formats a standard entry', () => {
    const entry: IndexEntry = { title: 'Foo', file: 'foo.md', description: 'A foo thing' };
    expect(formatIndexEntry(entry)).toBe('- [Foo](foo.md) — A foo thing');
  });

  it('truncates entries exceeding 150 chars', () => {
    const entry: IndexEntry = {
      title: 'Title',
      file: 'file.md',
      description: 'x'.repeat(200),
    };
    const result = formatIndexEntry(entry);
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result).toMatch(/\.\.\.$/);
  });

  it('handles entry where even the prefix exceeds 150 chars', () => {
    const entry: IndexEntry = {
      title: 'A'.repeat(140),
      file: 'file.md',
      description: 'desc',
    };
    const result = formatIndexEntry(entry);
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result).toMatch(/\.\.\.$/);
  });
});


// ---------------------------------------------------------------------------
// readIndex / writeIndex round-trip
// ---------------------------------------------------------------------------
describe('readIndex + writeIndex round-trip', () => {
  it('round-trips entries through write then read', async () => {
    const entries: IndexEntry[] = [
      { title: 'Alpha', file: 'alpha.md', description: 'First entry' },
      { title: 'Beta', file: 'beta.md', description: 'Second entry' },
    ];
    await writeIndex(testDir, entries);
    const result = await readIndex(testDir);
    expect(result).toEqual(entries);
  });

  it('returns empty array when MEMORY.md does not exist', async () => {
    const result = await readIndex(testDir);
    expect(result).toEqual([]);
  });

  it('skips blank lines and malformed lines', async () => {
    const content = [
      '- [Good](good.md) — valid entry',
      '',
      'this is not a valid line',
      '- [Also Good](also.md) — another valid entry',
      '',
    ].join('\n');
    await writeFile(join(testDir, ENTRYPOINT_NAME), content, 'utf-8');
    const result = await readIndex(testDir);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Good');
    expect(result[1].title).toBe('Also Good');
  });

  it('writes empty content for zero entries', async () => {
    await writeIndex(testDir, []);
    const raw = await readFile(join(testDir, ENTRYPOINT_NAME), 'utf-8');
    expect(raw).toBe('');
  });
});

// ---------------------------------------------------------------------------
// truncateIndexContent — line truncation
// ---------------------------------------------------------------------------
describe('truncateIndexContent — line limit', () => {
  it('does not truncate when within limits', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `- [T${i}](f${i}.md) — desc`);
    const raw = lines.join('\n') + '\n';
    const result = truncateIndexContent(raw, 200, 25_000);
    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
    // All original lines should be present
    for (const line of lines) {
      expect(result.content).toContain(line);
    }
  });

  it('truncates to maxLines and appends warning', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- [T${i}](f${i}.md) — desc ${i}`);
    const raw = lines.join('\n') + '\n';
    const result = truncateIndexContent(raw, 5, 25_000);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('lines');
    // Should contain the warning
    expect(result.content).toContain('Truncated');
    expect(result.content).toContain('5-line limit');
    // Should only have 5 content lines (plus the warning)
    const contentLines = result.content.split('\n').filter((l) => l.trim() && !l.startsWith('<!--'));
    expect(contentLines).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// truncateIndexContent — byte truncation
// ---------------------------------------------------------------------------
describe('truncateIndexContent — byte limit', () => {
  it('truncates to maxBytes and appends warning', () => {
    // Create lines that together exceed a small byte budget
    const lines = Array.from({ length: 20 }, (_, i) => `- [Title${i}](file${i}.md) — ${'x'.repeat(50)}`);
    const raw = lines.join('\n') + '\n';
    const tinyBudget = 300;
    const result = truncateIndexContent(raw, 200, tinyBudget);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('bytes');
    expect(Buffer.byteLength(result.content, 'utf-8')).toBeLessThanOrEqual(tinyBudget);
    expect(result.content).toContain('Truncated');
    expect(result.content).toContain('byte limit');
  });

  it('byte limit takes precedence when both limits are exceeded', () => {
    // 300 lines of ~80 chars each ≈ 24 KB, but set byte limit very low
    const lines = Array.from({ length: 300 }, (_, i) => `- [T${i}](f${i}.md) — ${'y'.repeat(60)}`);
    const raw = lines.join('\n') + '\n';
    const result = truncateIndexContent(raw, 200, 500);
    expect(result.truncated).toBe(true);
    // bytes is checked after lines, so if both exceed, bytes wins as the reason
    expect(result.reason).toBe('bytes');
    expect(Buffer.byteLength(result.content, 'utf-8')).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// truncateIndexContent — verbose entry demotion
// ---------------------------------------------------------------------------
describe('truncateIndexContent — verbose entry demotion', () => {
  it('demotes lines over 200 chars by truncating with ellipsis', () => {
    const longDesc = 'z'.repeat(250);
    const raw = `- [Long](long.md) — ${longDesc}\n`;
    const result = truncateIndexContent(raw, 200, 25_000);
    // The verbose line should have been shortened
    const contentLines = result.content.split('\n').filter((l) => l.trim() && !l.startsWith('<!--'));
    expect(contentLines).toHaveLength(1);
    expect(contentLines[0].length).toBeLessThanOrEqual(200);
    expect(contentLines[0]).toMatch(/\.\.\.$/);
  });

  it('leaves lines under 200 chars untouched', () => {
    const raw = '- [Short](short.md) — brief\n';
    const result = truncateIndexContent(raw, 200, 25_000);
    expect(result.content).toContain('- [Short](short.md) — brief');
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// truncateIndexContent — warning message specificity
// ---------------------------------------------------------------------------
describe('truncateIndexContent — warning messages', () => {
  it('warning specifies line limit when truncated by lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- [T${i}](f${i}.md) — d`);
    const raw = lines.join('\n') + '\n';
    const result = truncateIndexContent(raw, 3, 25_000);
    expect(result.content).toMatch(/<!-- Truncated: index exceeded 3-line limit -->/);
  });

  it('warning specifies byte limit when truncated by bytes', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `- [T${i}](f${i}.md) — ${'a'.repeat(80)}`);
    const raw = lines.join('\n') + '\n';
    const result = truncateIndexContent(raw, 200, 200);
    expect(result.content).toMatch(/<!-- Truncated: index exceeded 200-byte limit -->/);
  });
});
