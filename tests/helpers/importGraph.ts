/**
 * tests/helpers/importGraph.ts — which modules a source file names, and
 * every module reachable from it through relative imports. A suite uses it
 * to prove a module is a leaf: that nothing it loads, directly or through
 * another module, names a package such as @google/adk.
 *
 * A scan of the source, not a resolver: type-only imports count as imports,
 * and comments are skipped, so a module that mentions a package in its
 * documentation is not counted as importing it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The source with its comments blanked out. String and template literals are
 * kept whole, so a `//` inside a URL stays code; the files walked here put
 * no quote inside a regex literal before their imports.
 */
export function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** import/export ... from '<s>', import '<s>', import('<s>') and require('<s>'). */
const SPECIFIER = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*(['"])([^'"]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"]+)\5\s*\)/g;

/** The module specifiers a source file names, comments excluded. `file` is relative to the repo root. */
export function specifiersOf(file: string): string[] {
  const code = stripComments(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  return [...code.matchAll(SPECIFIER)].map((m) => m[2] ?? m[4] ?? m[6]);
}

/** Every module reachable from `entry` through relative specifiers, keyed by absolute path, with the specifiers each names. */
export function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [path.resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const specifiers = specifiersOf(file);
    graph.set(file, specifiers);
    for (const spec of specifiers) {
      if (spec.startsWith('.')) pending.push(path.resolve(path.dirname(file), spec));
    }
  }
  return graph;
}

/**
 * The import and export-from statements in a source file that load a module
 * at run time: every one that is not `import type` or `export type`. A
 * `type` modifier inside the braces does not count, because the statement
 * then still loads the module.
 */
export function runtimeImportsOf(file: string): string[] {
  const code = stripComments(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  const statements = code.match(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"][^'"]+['"]|^\s*import\s*['"][^'"]+['"]/gm) ?? [];
  return statements.map((s) => s.trim()).filter((s) => !/^(?:import|export)\s+type\b/.test(s));
}
