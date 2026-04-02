import type { MemoryType } from '../types.js';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;

export function parseMemoryType(raw: unknown): MemoryType | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.toLowerCase().trim();
  return (MEMORY_TYPES as readonly string[]).includes(lower)
    ? (lower as MemoryType)
    : null;
}
