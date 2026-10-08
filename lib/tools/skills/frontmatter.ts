/**
 * lib/tools/skills/frontmatter.ts — a SKILL.md's frontmatter, read and
 * checked by the engine (WS3-3, ADR 0083).
 *
 * WHY this file exists:
 *   A skill is a directory holding a SKILL.md that opens with YAML
 *   frontmatter (the open Agent Skills standard): `name`, `description`,
 *   and optionally `license`, `compatibility`, `allowed-tools` and
 *   `metadata`. The harness read it through ADK's loader until WS3-3. This
 *   module reads it the same way, so a skill loads to the same object on
 *   either runtime and the frontmatter a model sees in load_skill's result
 *   does not change:
 *   - the frontmatter is the text between the opening `---` and the next
 *     `---`, wherever it falls, and the body is everything after that,
 *     trimmed (ADK's `split('---')`);
 *   - the frontmatter must be a YAML mapping;
 *   - the fields are checked as ADK's FrontmatterSchema checks them, and
 *     the result has its key order: the standard's fields in their order,
 *     `metadata` defaulting to `{}`, then every other key as written, with
 *     `allowedTools` copied from `allowed-tools` after them.
 *
 * WHAT IS BOUNDED: the SKILL.md a caller hands in (MAX_SKILL_MD_CHARS) and
 *   the frontmatter inside it (MAX_FRONTMATTER_CHARS) are refused when
 *   larger, before any YAML is parsed. No regular expression runs on file
 *   text: the delimiters are found with indexOf and the name is checked one
 *   character at a time, so no input can make a pattern backtrack (CodeQL
 *   js/polynomial-redos). YAML aliases are capped by the `yaml` parser's own
 *   default (maxAliasCount).
 *
 * The frontmatter is data the operator installed. Nothing here acts on it;
 * the loader keeps it and load_skill shows it.
 */

import { parse as parseYaml } from 'yaml';

/** Characters a SKILL.md may hold. A larger file is refused, not read. */
export const MAX_SKILL_MD_CHARS = 1024 * 1024;

/** Characters the frontmatter block may hold. */
export const MAX_FRONTMATTER_CHARS = 64 * 1024;

/** The frontmatter keys the standard names, which validateSkillDir accepts. */
export const ALLOWED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  // The camel-case alias the reader derives from `allowed-tools`.
  'allowedTools',
  'metadata',
  'compatibility',
]);

/** The standard's fields, in the order a parsed frontmatter lists them. */
const SHAPE_KEYS = ['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata'] as const;

/** A skill's frontmatter, as the loader keeps it. */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  'allowed-tools'?: string;
  /** Copied from `allowed-tools` when only that spelling is written. */
  allowedTools?: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

/** The frontmatter as written (a YAML mapping) and the body after it. */
export interface ParsedSkillMd {
  raw: Record<string, unknown>;
  body: string;
}

const DELIMITER = '---';

/** One whitespace character, as `\s` matches it. */
const WHITESPACE = /^\s$/u;

const NAME_RULE =
  'name must be lowercase kebab-case (a-z, 0-9, hyphens) or snake_case (a-z, 0-9, underscores), with no leading, trailing, or consecutive delimiters. Mixing hyphens and underscores is not allowed.';

/**
 * Split a SKILL.md into its frontmatter mapping and its body. Throws with
 * ADK's texts: no opening `---`, no closing `---`, YAML that does not parse,
 * or frontmatter that is not a mapping.
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  if (content.length > MAX_SKILL_MD_CHARS) throw new Error(`SKILL.md is larger than ${MAX_SKILL_MD_CHARS} characters`);
  if (!content.startsWith(DELIMITER)) throw new Error('SKILL.md must start with YAML frontmatter (---)');
  const close = content.indexOf(DELIMITER, DELIMITER.length);
  if (close < 0) throw new Error('SKILL.md frontmatter not properly closed with ---');
  const block = content.slice(DELIMITER.length, close);
  if (block.length > MAX_FRONTMATTER_CHARS) throw new Error(`SKILL.md frontmatter is larger than ${MAX_FRONTMATTER_CHARS} characters`);
  const body = content.slice(close + DELIMITER.length).trim();
  let parsed: unknown;
  try {
    parsed = parseYaml(block, { logLevel: 'error' });
  } catch (e) {
    throw new Error(`Invalid YAML in frontmatter: ${firstLine(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid YAML in frontmatter: SKILL.md frontmatter must be a YAML mapping');
  }
  return { raw: parsed as Record<string, unknown>, body };
}

/** True when `name` is lowercase kebab-case or snake_case, never both, with no stray delimiter. */
export function isSkillName(name: string): boolean {
  if (name.length === 0) return false;
  let delimiter: string | undefined;
  let previousWasDelimiter = true; // a leading delimiter is refused
  for (const ch of name) {
    const isWordChar = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (isWordChar) {
      previousWasDelimiter = false;
      continue;
    }
    if (ch !== '-' && ch !== '_') return false;
    if (previousWasDelimiter) return false;
    if (delimiter !== undefined && delimiter !== ch) return false;
    delimiter = ch;
    previousWasDelimiter = true;
  }
  return !previousWasDelimiter;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(raw: Record<string, unknown>, key: string, max: number | undefined, problems: string[]): void {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined) return;
  const value = raw[key];
  if (typeof value !== 'string') problems.push(`${key}: expected a string`);
  else if (max !== undefined && value.length > max) problems.push(`${key}: at most ${max} characters`);
}

/** Set a key as data, so a key named __proto__ never becomes a prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Check a frontmatter mapping as ADK's FrontmatterSchema does and return it
 * in that schema's shape. Throws `Invalid frontmatter: …` naming each field
 * that fails.
 */
export function validateFrontmatter(raw: Record<string, unknown>): SkillFrontmatter {
  const problems: string[] = [];
  const name = raw.name;
  if (typeof name !== 'string') problems.push('name: expected a string');
  else {
    if (!isSkillName(name)) problems.push(`name: ${NAME_RULE}`);
    if (name.length > 64) problems.push('name: at most 64 characters');
  }
  const description = raw.description;
  if (typeof description !== 'string') problems.push('description: expected a string');
  else if (description.length < 1) problems.push('description: must not be empty');
  else if (description.length > 1024) problems.push('description: at most 1024 characters');
  optionalString(raw, 'license', undefined, problems);
  optionalString(raw, 'compatibility', 500, problems);
  optionalString(raw, 'allowed-tools', undefined, problems);
  const hasMetadata = Object.hasOwn(raw, 'metadata') && raw.metadata !== undefined;
  if (hasMetadata) {
    const metadata = raw.metadata;
    if (!isPlainRecord(metadata)) problems.push('metadata: expected a mapping');
    else if (Object.hasOwn(metadata, 'adk_additional_tools')) {
      const extra = metadata.adk_additional_tools;
      if (!Array.isArray(extra) || !extra.every((item) => typeof item === 'string')) problems.push('metadata: adk_additional_tools must be a list of strings');
    }
  }
  if (problems.length > 0) throw new Error(`Invalid frontmatter: ${problems.join('; ')}`);

  // The input as ADK's preprocessor sees it: `allowedTools` after the keys as written.
  const input: Array<[string, unknown]> = Object.keys(raw).map((k) => [k, raw[k]]);
  if (Object.hasOwn(raw, 'allowed-tools') && !Object.hasOwn(raw, 'allowedTools')) input.push(['allowedTools', raw['allowed-tools']]);

  const out: Record<string, unknown> = {};
  for (const key of SHAPE_KEYS) {
    if (key === 'metadata') {
      const metadata: Record<string, unknown> = {};
      if (hasMetadata) for (const [k, v] of Object.entries(raw.metadata as Record<string, unknown>)) put(metadata, k, v);
      out.metadata = metadata;
    } else if (Object.hasOwn(raw, key) && raw[key] !== undefined) {
      put(out, key, raw[key]);
    }
  }
  const shape = new Set<string>(SHAPE_KEYS);
  for (const [key, value] of input) if (!shape.has(key)) put(out, key, value);
  return out as SkillFrontmatter;
}

/** Parse and check a SKILL.md: its frontmatter in the schema's shape and its body. */
export function parseSkillMdContent(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const { raw, body } = parseSkillMd(content);
  return { frontmatter: validateFrontmatter(raw), body };
}

/**
 * The tool names `allowed-tools` lists: the open standard's space- or
 * comma-separated string, split without a regular expression.
 */
export function splitAllowedTools(declared: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of declared) {
    // One character tested at a time: the pattern has nothing to backtrack over.
    if (ch === ',' || WHITESPACE.test(ch)) {
      if (current) out.push(current);
      current = '';
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const newline = message.indexOf('\n');
  return newline < 0 ? message : message.slice(0, newline);
}
