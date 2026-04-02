import YAML from 'yaml';
import { log } from '../logger.js';
import { parseMemoryType } from './memoryTypes.js';
import type { MemoryFrontmatter, ParsedMemoryFile } from '../types.js';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

export function parseFrontmatter(raw: string): ParsedMemoryFile | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    log('warn', 'frontmatter:missing', { reason: 'no frontmatter block found' });
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(match[1]) as Record<string, unknown>;
  } catch (err) {
    log('warn', 'frontmatter:malformed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (parsed == null || typeof parsed !== 'object') {
    log('warn', 'frontmatter:malformed', { reason: 'frontmatter is not an object' });
    return null;
  }

  const frontmatter: MemoryFrontmatter = {
    name: typeof parsed.name === 'string' ? parsed.name : '',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    type: parseMemoryType(parsed.type),
  };

  const body = raw.slice(match[0].length);
  return { frontmatter, body };
}

export function serializeFrontmatter(fm: MemoryFrontmatter, body: string): string {
  const obj: Record<string, unknown> = {
    name: fm.name,
    description: fm.description,
  };
  if (fm.type !== null) {
    obj.type = fm.type;
  }

  const yamlStr = YAML.stringify(obj).trimEnd();
  return `---\n${yamlStr}\n---\n${body}`;
}
