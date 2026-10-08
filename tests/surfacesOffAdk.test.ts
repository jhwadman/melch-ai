/**
 * tests/surfacesOffAdk.test.ts — the surfaces run on the engine's own
 * interfaces (ADR 0080, WS2-13, ADR 0107).
 *
 * The A2A executor and app, the REPL, the worker, the server bin and the
 * demo scripts name no @google/* module themselves, and the direct call's
 * runtime import graph reaches @google/ only through the Gemini adapter's
 * client. The engine's log level is a leaf every surface sets. The
 * repository-wide line (no ADK anywhere, @google/genai only where it
 * belongs) is tests/importGraph.test.ts.
 *
 * Offline: reads sources; no model is called.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runtimeImportsOf, specifiersOf, ROOT } from './helpers/importGraph.ts';
import { LOG_LEVELS, logLevel, logs, onLogLevel, setLogLevel } from '../lib/runtime/logging.ts';
import type { LogLevelName } from '../lib/runtime/logging.ts';

/** The surfaces WS2-13 moved onto the engine's interfaces. */
const SURFACES = [
  'lib/a2a/executor.ts',
  'lib/a2a/app.ts',
  'scripts/a2a_server.ts',
  'scripts/syndicate_chat.ts',
  'scripts/assistant_worker.ts',
  'scripts/demo_model_optionality.ts',
  'scripts/direct_call.ts',
];

const namesGoogle = (specifier: string) => specifier.startsWith('@google/');

test('no surface imports @google/* itself, as a value or a type', () => {
  for (const file of SURFACES) {
    const named = specifiersOf(file).filter(namesGoogle);
    assert.deepEqual(named, [], `${file} imports ${named.join(', ')}`);
  }
});

/** Every module reachable from `entry` through runtime (non-type) static imports, with the specifiers each names. */
function runtimeGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [path.resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const specs = runtimeImportsOf(file).map((statement) => /['"]([^'"]+)['"]\s*$/.exec(statement)![1]);
    graph.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) pending.push(path.resolve(path.dirname(file), s));
  }
  return graph;
}

test("the direct call's runtime import graph reaches @google/ only through the Gemini adapter", () => {
  const google = [...runtimeGraph('scripts/direct_call.ts')].flatMap(([file, specs]) =>
    specs.filter(namesGoogle).map((s) => `${path.relative(ROOT, file)} → ${s}`),
  );
  const allowed = new Set(['lib/models/geminiAdapter.ts → @google/genai', 'lib/models/genaiMapping.ts → @google/genai']);
  assert.deepEqual(google.filter((line) => !allowed.has(line)), []);
  assert.ok(google.length > 0, 'control: the walk sees the Gemini SDK where it is');
});

test('the log level is a leaf, and a subscriber follows it once a surface sets one', () => {
  assert.deepEqual(specifiersOf('lib/runtime/logging.ts'), []);
  const seen: LogLevelName[] = [];
  const off = onLogLevel((level) => seen.push(level));
  try {
    for (const level of LOG_LEVELS) {
      setLogLevel(level);
      assert.equal(logLevel(), level);
      assert.equal(seen.at(-1), level);
    }
    setLogLevel('warn');
    assert.equal(logs('error'), true);
    assert.equal(logs('warn'), true);
    assert.equal(logs('info'), false);
    assert.throws(() => setLogLevel('loud' as LogLevelName), /Unknown log level/);
    // A late subscriber gets the level already set.
    let late: LogLevelName | undefined;
    const offLate = onLogLevel((level) => {
      late = level;
    });
    assert.equal(late, 'warn');
    offLate();
  } finally {
    off();
    setLogLevel('error');
  }
});
