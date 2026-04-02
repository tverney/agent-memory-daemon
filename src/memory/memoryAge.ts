const MS_PER_DAY = 86_400_000;

export function memoryAgeDays(mtimeMs: number): number {
  return Math.floor((Date.now() - mtimeMs) / MS_PER_DAY);
}

export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function memoryFreshnessText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 0) return 'This memory is current.';
  if (days === 1) return 'This memory is from yesterday — verify before relying on it.';
  return `This memory is ${days} days old — treat as a point-in-time observation that may be outdated.`;
}

export function memoryFreshnessNote(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 0) return '';
  const text = memoryFreshnessText(mtimeMs);
  return `<system-reminder>${text}</system-reminder>`;
}
