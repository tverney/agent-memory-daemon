import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import type { MemoryFrontmatter } from '../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

/**
 * Arbitrary for generating safe YAML strings that won't confuse
 * the frontmatter parser or YAML parser.
 * Avoids strings starting with '---' (frontmatter delimiter) and
 * filters out characters/patterns that break YAML round-tripping.
 */
const safeYamlString = fc.string().filter((s) => {
  // Must not start with '---' (frontmatter delimiter)
  if (s.trimStart().startsWith('---')) return false;
  // Avoid null bytes which YAML doesn't handle
  if (s.includes('\0')) return false;
  return true;
});

/**
 * Arbitrary for generating valid MemoryFrontmatter objects.
 */
const memoryFrontmatterArb: fc.Arbitrary<MemoryFrontmatter> = fc.record({
  name: safeYamlString,
  description: safeYamlString,
  type: fc.constantFrom<MemoryFrontmatter['type']>(
    'user',
    'feedback',
    'project',
    'reference',
    null,
  ),
});

/**
 * Arbitrary for generating body strings that round-trip correctly.
 * The frontmatter regex `---\s*\n?` after the closing delimiter
 * consumes any leading whitespace from the body, so we constrain
 * bodies to not start with whitespace.
 */
const bodyArb = safeYamlString.filter((s) => s.length === 0 || /^\S/.test(s));

describe('frontmatter round-trip property', () => {
  /**
   * **Validates: Requirements 9.3**
   *
   * For all valid MemoryFrontmatter and body strings,
   * parseFrontmatter(serializeFrontmatter(fm, body)) produces
   * an equivalent object.
   */
  it('parseFrontmatter(serializeFrontmatter(fm, body)) round-trips correctly', () => {
    fc.assert(
      fc.property(memoryFrontmatterArb, bodyArb, (fm, body) => {
        const serialized = serializeFrontmatter(fm, body);
        const parsed = parseFrontmatter(serialized);

        // Must parse successfully
        expect(parsed).not.toBeNull();

        // Frontmatter fields must match
        expect(parsed!.frontmatter.name).toBe(fm.name);
        expect(parsed!.frontmatter.description).toBe(fm.description);
        expect(parsed!.frontmatter.type).toBe(fm.type);

        // Body must match
        expect(parsed!.body).toBe(body);
      }),
      { numRuns: 200 },
    );
  });
});


describe('parseFrontmatter edge cases', () => {
  it('returns null when no frontmatter block is present', () => {
    expect(parseFrontmatter('just plain text')).toBeNull();
  });

  it('returns null for malformed YAML inside frontmatter', () => {
    const raw = '---\n: : : bad yaml\n---\nbody';
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('defaults missing name and description to empty strings', () => {
    const raw = '---\ntype: user\n---\nbody';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('');
    expect(result!.frontmatter.description).toBe('');
    expect(result!.frontmatter.type).toBe('user');
  });

  it('sets type to null for unrecognised type value', () => {
    const raw = '---\nname: test\ntype: banana\n---\nbody';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.type).toBeNull();
  });

  it('sets type to null when type field is missing', () => {
    const raw = '---\nname: test\ndescription: desc\n---\nbody';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.type).toBeNull();
  });

  it('sets type to null when type is a non-string value', () => {
    const raw = '---\nname: test\ntype: 42\n---\nbody';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.type).toBeNull();
  });

  it('returns null when frontmatter parses to a scalar instead of object', () => {
    const raw = '---\njust a string\n---\nbody';
    // YAML parses "just a string" as a scalar, not an object
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('handles empty frontmatter block', () => {
    const raw = '---\n---\nbody';
    // YAML.parse of empty string returns null → not an object
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('preserves body content after frontmatter', () => {
    const raw = '---\nname: n\n---\n# Heading\n\nSome content.';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.body).toBe('# Heading\n\nSome content.');
  });
});

describe('serializeFrontmatter', () => {
  it('omits type field when type is null', () => {
    const serialized = serializeFrontmatter(
      { name: 'test', description: 'desc', type: null },
      'body',
    );
    expect(serialized).not.toContain('type:');
    expect(serialized).toContain('name: test');
  });

  it('includes type field when type is set', () => {
    const serialized = serializeFrontmatter(
      { name: 'test', description: 'desc', type: 'project' },
      'body',
    );
    expect(serialized).toContain('type: project');
  });
});
