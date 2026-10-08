/**
 * tests/importGraph.test.ts — no Google ADK, and Google's SDK only where it
 * belongs (ADR 0107).
 *
 * 1.0.0 removed the ADK runtime and the ADK dependency. This suite holds the
 * line from source: no module under lib/ or scripts/ names any @google/
 * package except the Gemini SDK (@google/genai), and only these modules name
 * it, as a value or a type:
 *   - the Gemini adapter (lib/models/geminiAdapter.ts) and the genai mapping
 *     it and the stored events speak (lib/models/genaiMapping.ts);
 *   - the image tools (lib/tools/generateImageTool.ts,
 *     lib/tools/inspectImageTool.ts, and lib/tools/xApiSearchTool.ts, whose
 *     photos a Gemini vision pass transcribes);
 *   - memory embeddings (lib/memory/providers.ts).
 * package.json declares @google/genai alone among Google's packages. The
 * scan reads source with comments blanked (tests/helpers/importGraph.ts):
 * type-only imports count, a mention in a comment does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, specifiersOf } from './helpers/importGraph.ts';

/** The modules that may import @google/genai, and the reason each does. */
const GENAI_ALLOWED: Record<string, string> = {
  'lib/models/geminiAdapter.ts': 'the Gemini adapter',
  'lib/models/genaiMapping.ts': "the genai shapes the Gemini adapter and the stored events speak",
  'lib/tools/generateImageTool.ts': 'an image tool',
  'lib/tools/inspectImageTool.ts': 'an image tool',
  'lib/tools/xApiSearchTool.ts': "an image tool's Gemini vision pass over posted photos",
  'lib/memory/providers.ts': 'memory embeddings',
};

const GENAI = '@google/genai';

/** Every source file under `dir` (relative to the repo root) with one of `exts`. */
function sources(dir: string, exts: readonly string[]): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true })
    .map(String)
    .filter((f) => exts.some((e) => f.endsWith(e)) && !f.endsWith('.d.ts'))
    .map((f) => path.join(dir, f))
    .sort();
}

const LIB = sources('lib', ['.ts']);
const SCRIPTS = sources('scripts', ['.ts', '.mjs', '.js']);

/** Every `@google/` specifier a file names, as `file → specifier`. */
const googleImports = (files: readonly string[]): string[] =>
  files.flatMap((file) => specifiersOf(file).filter((s) => s.startsWith('@google/')).map((s) => `${file} → ${s}`));

test('the scan covers lib/ and scripts/', () => {
  assert.ok(LIB.length > 150, `${LIB.length} lib modules`);
  assert.ok(SCRIPTS.length > 20, `${SCRIPTS.length} scripts`);
  for (const file of Object.keys(GENAI_ALLOWED)) assert.ok(LIB.includes(file), `${file} exists`);
});

test('lib/: @google/ appears only as @google/genai, and only in the Gemini adapter, the image tools and memory embeddings', () => {
  const found = googleImports(LIB);
  const outside = found.filter((line) => {
    const [file, spec] = line.split(' → ');
    return spec !== GENAI || !(file in GENAI_ALLOWED);
  });
  assert.deepEqual(outside, []);
  // Each allowed module does use it: an entry no one needs any more leaves the list.
  for (const file of Object.keys(GENAI_ALLOWED)) assert.ok(found.includes(`${file} → ${GENAI}`), `${file} no longer imports ${GENAI}: drop it from the list`);
});

test('scripts/: no script imports any @google/ package', () => {
  assert.deepEqual(googleImports(SCRIPTS), []);
});

test('no file under lib/ or scripts/ names the ADK package, in code or in a comment', () => {
  const adk = ['@google', 'adk'].join('/');
  const naming = [...LIB, ...SCRIPTS].filter((file) => fs.readFileSync(path.join(ROOT, file), 'utf8').includes(adk));
  assert.deepEqual(naming, []);
});

test('package.json declares @google/genai alone among Google packages, in every dependency list', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
  const google: string[] = [];
  for (const list of ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[list] ?? {})) if (name.startsWith('@google/')) google.push(`${list}: ${name}`);
  }
  assert.deepEqual(google, [`dependencies: ${GENAI}`]);
});

test('the scan sees a @google/ import however it is written, and skips one in a comment (control)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-'));
  try {
    const file = path.join(dir, 'probe.ts');
    fs.writeFileSync(
      file,
      [
        "import type { A } from '@google/one';",
        "import { B } from \"@google/two\";",
        "export { C } from '@google/three';",
        "const d = await import('@google/four');",
        "// import { E } from '@google/five';",
        "/* import { F } from '@google/six'; */",
      ].join('\n'),
    );
    const specs = specifiersOf(file).filter((s) => s.startsWith('@google/'));
    assert.deepEqual(specs, ['@google/one', '@google/two', '@google/three', '@google/four']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
