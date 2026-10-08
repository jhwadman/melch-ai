/**
 * tests/surfacesOffAdk.test.ts — the surfaces run on the engine's own
 * interfaces (ADR 0080, WS2-13).
 *
 * The A2A executor and app, the REPL, the worker, the server bin and the
 * demo scripts name no @google/* module themselves. They reach ADK only
 * through compileAdk (which the turn runner loads) and the compatibility
 * layer: the session bridge (ADR 0058) and the memory bridge. The direct
 * call loads no ADK at all (the Gemini adapter's @google/genai client aside). This suite fails when one of them imports ADK
 * again, and holds the pieces they stand on: the bridges' pass-through,
 * wrapping and unwrapping, and the engine's log level, which ADK's logger
 * follows.
 *
 * Offline: reads sources and runs in-process stores; no model is called.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { InMemorySessionService, LogLevel, resetLogger, setLogger } from '@google/adk';
import type { Logger } from '@google/adk';

import { runtimeImportsOf, specifiersOf, ROOT } from './helpers/importGraph.ts';
import '../lib/compileAdk.ts';
import {
  AdkSessionServiceForEngine,
  SessionServiceForAdk,
  asAdkSessionService,
  asSessionService,
} from '../lib/runtime/adkSessionBridge.ts';
import { MemoryServiceForAdk, asAdkMemoryService, isAdkMemoryService } from '../lib/runtime/adkMemoryBridge.ts';
import { LOG_LEVELS, logLevel, logs, onLogLevel, setLogLevel } from '../lib/runtime/logging.ts';
import type { LogLevelName } from '../lib/runtime/logging.ts';
import type { MemoryIngestOptions, MemorySearchRequest, MemoryService } from '../lib/runtime/memoryService.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { Session } from '../lib/runtime/sessions.ts';
import { namespacedMemoryService } from '../lib/memory/namespace.ts';

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
    assert.deepEqual(named, [], `${file} imports ${named.join(', ')}: reach ADK through compileAdk or a bridge`);
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

const isAdk = (specifier: string) => specifier === '@google/adk' || specifier.startsWith('@google/adk/');

test('the direct call loads no ADK: nothing in its runtime import graph names @google/adk', () => {
  const adk = [...runtimeGraph('scripts/direct_call.ts')].flatMap(([file, specs]) =>
    specs.filter(isAdk).map((s) => `${path.relative(ROOT, file)} → ${s}`),
  );
  assert.deepEqual(adk, []);
  // Control: the walk sees ADK where it is.
  assert.ok([...runtimeGraph('scripts/syndicate_chat.ts')].some(([, specs]) => specs.some(isAdk)));
});

test('the scan sees an ADK import however it is written', () => {
  // specifiersOf reads a file, so the patterns are checked on this suite's own source.
  const own = specifiersOf('tests/surfacesOffAdk.test.ts').filter(namesGoogle);
  assert.ok(own.includes('@google/adk'), 'this suite imports ADK, and the scan sees it');
});

test('the log level is a leaf, and ADK\'s logger follows it once a surface sets one', () => {
  assert.deepEqual(specifiersOf('lib/runtime/logging.ts'), []);
  const seen: LogLevel[] = [];
  const recorder: Logger = {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    setLogLevel(level: LogLevel) {
      seen.push(level);
    },
  };
  setLogger(recorder);
  try {
    const expected: Record<LogLevelName, LogLevel> = {
      debug: LogLevel.DEBUG,
      info: LogLevel.INFO,
      warn: LogLevel.WARN,
      error: LogLevel.ERROR,
    };
    for (const level of LOG_LEVELS) {
      setLogLevel(level);
      assert.equal(logLevel(), level);
      assert.equal(seen.at(-1), expected[level]);
    }
    setLogLevel('warn');
    assert.equal(logs('error'), true);
    assert.equal(logs('warn'), true);
    assert.equal(logs('info'), false);
    assert.throws(() => setLogLevel('loud' as LogLevelName), /Unknown log level/);
    // A late subscriber gets the level already set.
    let late: LogLevelName | undefined;
    const off = onLogLevel((level) => {
      late = level;
    });
    assert.equal(late, 'warn');
    off();
  } finally {
    setLogLevel('error');
    resetLogger();
  }
});

// ── The session bridge ───────────────────────────────────────────────────────

test('a store bridged one way and back is the store itself', () => {
  const engine = new InProcessSessionService();
  const forAdk = asAdkSessionService(engine);
  assert.ok(forAdk instanceof SessionServiceForAdk);
  assert.equal(asSessionService(forAdk), engine);

  const adk = new InMemorySessionService();
  const forEngine = asSessionService(adk);
  assert.ok(forEngine instanceof AdkSessionServiceForEngine);
  assert.equal(asAdkSessionService(forEngine), adk);
});

// ── The memory bridge ────────────────────────────────────────────────────────

/** An engine-only memory service that records what it was asked. */
function engineMemory(extras = false) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service: MemoryService = {
    async ingest(session: Session, options?: MemoryIngestOptions) {
      calls.push({ method: 'ingest', args: [session.appName, options] });
    },
    async search(request: MemorySearchRequest) {
      calls.push({ method: 'search', args: [request] });
      return { memories: [{ content: { role: 'user', parts: [{ text: `fact for ${request.userId}` }] }, author: 'memory_service' }] };
    },
    ...(extras
      ? {
          async deleteUserMemory(userKey: string) {
            calls.push({ method: 'deleteUserMemory', args: [userKey] });
            return 3;
          },
          async pruneExpired(namespace: string, days: number) {
            calls.push({ method: 'pruneExpired', args: [namespace, days] });
            return 1;
          },
          async verifyEmbeddingDimensions() {
            calls.push({ method: 'verifyEmbeddingDimensions', args: [] });
          },
        }
      : {}),
  };
  return { service, calls };
}

test('a service with ADK\'s face passes through the memory bridge unchanged', () => {
  const adk = {
    async addSessionToMemory() {},
    async searchMemory() {
      return { memories: [] };
    },
  };
  assert.equal(asAdkMemoryService(adk), adk);
  assert.throws(() => asAdkMemoryService({} as MemoryService), /Not a memory service/);
});

test('an engine-only service gets ADK\'s face: search, ingest with rules and model, namespace kept', async () => {
  const { service, calls } = engineMemory();
  const pinned = namespacedMemoryService(service, 'zoo.ns');
  const adk = asAdkMemoryService(pinned);
  assert.ok(adk instanceof MemoryServiceForAdk);
  assert.ok(isAdkMemoryService(adk));

  const found = await adk.searchMemory({ appName: 'ignored', userId: 'u1', query: 'what do I like?' });
  assert.equal(found.memories.length, 1);
  assert.deepEqual(calls[0], { method: 'search', args: [{ appName: 'zoo.ns', userId: 'u1', query: 'what do I like?' }] });

  const session = { id: 's', appName: 'ignored', userId: 'u1', state: {}, events: [], lastUpdateTime: 0 };
  await (adk as MemoryServiceForAdk).addSessionToMemory(session as never, 'keep names only', { extractionModel: 'gemini-x' });
  assert.deepEqual(calls[1], { method: 'ingest', args: ['zoo.ns', { extractionRules: 'keep names only', extractionModel: 'gemini-x' }] });

  await adk.addSessionToMemory(session as never);
  assert.deepEqual(calls[2], { method: 'ingest', args: ['zoo.ns', {}] });

  // No extras on the service, none on the bridge: the server's by-name checks find nothing.
  const bridged = adk as MemoryServiceForAdk;
  assert.equal(bridged.deleteUserMemory, undefined);
  assert.equal(bridged.pruneExpired, undefined);
  assert.equal(bridged.verifyEmbeddingDimensions, undefined);
});

test('the memory bridge forwards erase, retention and the dimension check when the service has them', async () => {
  const { service, calls } = engineMemory(true);
  const adk = asAdkMemoryService(service) as MemoryServiceForAdk;
  assert.equal(await adk.deleteUserMemory!('app/u1'), 3);
  assert.equal(await adk.pruneExpired!('zoo.ns', 30), 1);
  await adk.verifyEmbeddingDimensions!();
  assert.deepEqual(calls.map((c) => c.method), ['deleteUserMemory', 'pruneExpired', 'verifyEmbeddingDimensions']);
});
