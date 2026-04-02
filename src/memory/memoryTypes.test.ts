import { describe, it, expect } from 'vitest';
import { MEMORY_TYPES, parseMemoryType } from './memoryTypes.js';

describe('MEMORY_TYPES', () => {
  it('contains exactly the four canonical types', () => {
    expect(MEMORY_TYPES).toEqual(['user', 'feedback', 'project', 'reference']);
  });
});

describe('parseMemoryType', () => {
  it.each(['user', 'feedback', 'project', 'reference'] as const)(
    'accepts valid type "%s"',
    (type) => {
      expect(parseMemoryType(type)).toBe(type);
    },
  );

  it('normalises uppercase input', () => {
    expect(parseMemoryType('USER')).toBe('user');
    expect(parseMemoryType('Feedback')).toBe('feedback');
  });

  it('trims whitespace', () => {
    expect(parseMemoryType('  project  ')).toBe('project');
  });

  it('returns null for unrecognised string', () => {
    expect(parseMemoryType('unknown')).toBeNull();
    expect(parseMemoryType('memo')).toBeNull();
    expect(parseMemoryType('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(parseMemoryType(undefined)).toBeNull();
    expect(parseMemoryType(null)).toBeNull();
    expect(parseMemoryType(42)).toBeNull();
    expect(parseMemoryType(true)).toBeNull();
    expect(parseMemoryType({})).toBeNull();
    expect(parseMemoryType([])).toBeNull();
  });
});
