import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
} from './memoryAge.js';

const MS_PER_DAY = 86_400_000;

// Fix Date.now so tests are deterministic
const NOW = 1_700_000_000_000; // arbitrary fixed timestamp
vi.spyOn(Date, 'now').mockReturnValue(NOW);

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('memoryAgeDays', () => {
  it('returns 0 for a file modified right now', () => {
    expect(memoryAgeDays(NOW)).toBe(0);
  });

  it('returns 1 for a file modified exactly one day ago', () => {
    expect(memoryAgeDays(NOW - MS_PER_DAY)).toBe(1);
  });

  it('returns 7 for a file modified one week ago', () => {
    expect(memoryAgeDays(NOW - 7 * MS_PER_DAY)).toBe(7);
  });

  it('floors partial days', () => {
    // 1.9 days → 1
    expect(memoryAgeDays(NOW - 1.9 * MS_PER_DAY)).toBe(1);
  });
});

describe('memoryAge', () => {
  it('returns "today" for age 0', () => {
    expect(memoryAge(NOW)).toBe('today');
  });

  it('returns "yesterday" for age 1', () => {
    expect(memoryAge(NOW - MS_PER_DAY)).toBe('yesterday');
  });

  it('returns "N days ago" for age >= 2', () => {
    expect(memoryAge(NOW - 3 * MS_PER_DAY)).toBe('3 days ago');
  });
});

describe('memoryFreshnessText', () => {
  it('says current for today', () => {
    expect(memoryFreshnessText(NOW)).toBe('This memory is current.');
  });

  it('adds verify caveat for yesterday', () => {
    const text = memoryFreshnessText(NOW - MS_PER_DAY);
    expect(text).toContain('yesterday');
    expect(text).toContain('verify');
  });

  it('adds outdated caveat for older memories', () => {
    const text = memoryFreshnessText(NOW - 5 * MS_PER_DAY);
    expect(text).toContain('5 days old');
    expect(text).toContain('outdated');
  });
});

describe('memoryFreshnessNote', () => {
  it('returns empty string for current memories', () => {
    expect(memoryFreshnessNote(NOW)).toBe('');
  });

  it('wraps in system-reminder tag for stale memories', () => {
    const note = memoryFreshnessNote(NOW - 2 * MS_PER_DAY);
    expect(note).toMatch(/^<system-reminder>.*<\/system-reminder>$/);
    expect(note).toContain('2 days old');
  });
});
