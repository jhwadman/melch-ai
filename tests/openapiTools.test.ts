/**
 * tests/openapiTools.test.ts — an agent's `openapi:` entries
 * (lib/tools/openapiTools.ts): GET-only by default, named operations, auth
 * from the environment, the SSRF guard, bounded results, a turn that calls an
 * operation, a write that waits for approval, spec paths beside the YAML, and
 * the schema. A real HTTP server on 127.0.0.1; scripted models.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';

import { MAX_RESULT_CHARS, buildOpenApiTools, toSnake } from '../lib/tools/openapiTools.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const seen: Array<{ method: string; url: string; auth?: string; key?: string; body: string }> = [];
const pets: Record<string, string> = { p1: 'Rex' };
let server: Server;
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'melch-openapi-'));

function spec(url: string): string {
  return `openapi: 3.0.0
info: { title: Pets, version: "1" }
servers: [{ url: "${url}" }]
paths:
  /pets:
    get: { operationId: listPets, summary: List the pets, responses: { "200": { description: ok } } }
    post:
      operationId: createPet
      summary: Add a pet
      requestBody: { content: { application/json: { schema: { type: object, properties: { name: { type: string } }, required: [name] } } } }
      responses: { "201": { description: ok } }
  /pets/{petId}:
    get: { operationId: getPet, summary: One pet, parameters: [{ name: petId, in: path, required: true, schema: { type: string } }], responses: { "200": { description: ok } } }
    delete: { operationId: deletePet, parameters: [{ name: petId, in: path, required: true, schema: { type: string } }], responses: { "204": { description: ok } } }
  /big:
    get: { operationId: getBig, summary: A large response, responses: { "200": { description: ok } } }
`;
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/big') return res.end(JSON.stringify({ blob: 'x'.repeat(MAX_RESULT_CHARS + 500) }));
      if (req.method === 'GET' && req.url === '/pets') return res.end(JSON.stringify(Object.entries(pets).map(([id, name]) => ({ id, name }))));
      if (req.method === 'POST' && req.url === '/pets') {
        const { name } = JSON.parse(body);
        pets[`p${Object.keys(pets).length + 1}`] = name;
        res.statusCode = 201;
        return res.end(JSON.stringify({ created: name }));
      }
      const m = req.url!.match(/^\/pets\/([^/]+)$/);
      if (m && req.method === 'GET') return res.end(JSON.stringify({ id: decodeURIComponent(m[1]!), name: pets[decodeURIComponent(m[1]!)] ?? null }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'no route' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  writeFileSync(join(dir, 'pets.yaml'), spec(base));
  process.env.ALLOW_PRIVATE_OPENAPI = 'true';
});
after(() => {
  server?.close();
  delete process.env.ALLOW_PRIVATE_OPENAPI;
});

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();
/** A tool context with the session state ADK's auth handler reads and may write. */
function context() {
  const state = new Map<string, unknown>();
  return {
    state,
    toolContext: {
      state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v), has: (k: string) => state.has(k) },
      getAuthResponse: () => undefined,
      requestCredential: () => {},
    } as any,
  };
}
const run = (tool: any, args: Record<string, unknown>, ctx = context()) => tool.runAsync({ args, toolContext: ctx.toolContext });

test('toSnake names an operationId the way ADK names the tool', () => {
  assert.equal(toSnake('listPets'), 'list_pets');
  assert.equal(toSnake('getHTTPStatus'), 'get_httpstatus');
});

test('without operations, only GET operations become tools; named operations expose writes', async () => {
  assert.deepEqual(names(await buildOpenApiTools({ spec: 'pets.yaml' }, dir)), ['get_big', 'get_pet', 'list_pets']);
  assert.deepEqual(names(await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets', 'create_pet'] }, dir)), ['create_pet', 'list_pets']);
  await assert.rejects(buildOpenApiTools({ spec: 'pets.yaml', operations: ['feedPets'] }, dir), /no operation 'feedPets' \(the spec has listPets, createPet, getPet, deletePet, getBig\)/);
  assert.deepEqual(names(await buildOpenApiTools({ spec: 'pets.yaml', prefix: 'zoo', operations: ['listPets'] }, dir)), ['zoo_list_pets']);
});

test('a tool calls the API with the model\'s arguments, path parameters encoded', async () => {
  const [getPet] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['getPet'] }, dir);
  seen.length = 0;
  assert.deepEqual(await run(getPet, { pet_id: 'p1' }), { id: 'p1', name: 'Rex' });
  await run(getPet, { pet_id: 'a/b?c' });
  assert.equal(seen[1]!.url, '/pets/a%2Fb%3Fc', 'a path parameter cannot change the path');
});

test('auth comes from the environment; an unset variable fails the build', async () => {
  process.env.PETS_TOKEN = 'tok-123';
  process.env.PETS_KEY = 'key-456';
  try {
    const [bearer] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], auth: { bearer_env: 'PETS_TOKEN' } }, dir);
    const [keyed] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], auth: { api_key: { env: 'PETS_KEY', in: 'header', name: 'X-Api-Key' } } }, dir);
    seen.length = 0;
    const ctx = context();
    await run(bearer, {}, ctx);
    await run(keyed, {}, ctx);
    assert.equal(seen[0]!.auth, 'Bearer tok-123');
    assert.equal(seen[1]!.key, 'key-456');
    // A static token is applied, never stored: session state can be durable.
    assert.doesNotMatch(JSON.stringify([...ctx.state.entries()]), /tok-123|key-456/);
  } finally {
    delete process.env.PETS_TOKEN;
    delete process.env.PETS_KEY;
  }
  await assert.rejects(buildOpenApiTools({ spec: 'pets.yaml', auth: { bearer_env: 'PETS_TOKEN' } }, dir), /PETS_TOKEN is not set/);
});

test('the SSRF guard refuses a private server unless ALLOW_PRIVATE_OPENAPI', async () => {
  delete process.env.ALLOW_PRIVATE_OPENAPI;
  try {
    await assert.rejects(buildOpenApiTools({ spec: 'pets.yaml' }, dir), /refusing 127\.0\.0\.1/);
    await assert.rejects(buildOpenApiTools({ spec: 'pets.yaml', base_url: 'http://169.254.169.254/latest' }, dir), /refusing 169\.254\.169\.254/);
    // A public name passes the build offline; the call resolves it first.
    const { setHostResolver } = await import('../lib/net/addressGuard.ts');
    const [named] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], base_url: 'https://pets.example.com' }, dir);
    setHostResolver(async () => [{ address: '10.0.0.7' }]);
    try {
      assert.match(String(((await run(named, {})) as any).error), /list_pets was not called: refusing pets\.example\.com: resolves to a private IPv4 address/);
    } finally {
      setHostResolver();
    }
  } finally {
    process.env.ALLOW_PRIVATE_OPENAPI = 'true';
  }
  await assert.rejects(buildOpenApiTools({ spec: 'missing.yaml' }, dir), /spec not found/);
});

test('a large response is cut and says so; a dead server is an error, not a throw', async () => {
  const [big] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['getBig'] }, dir);
  const result = (await run(big, {})) as { truncated: boolean; text: string };
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[cut at 20000 characters\]$/);
  const [dead] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], base_url: 'http://127.0.0.1:9' }, dir);
  assert.match(String(((await run(dead, {})) as any).error), /list_pets failed/);
});

function agentConfig(extra: Record<string, unknown>): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Pets',
      orchestrator: { name: 'Keeper', model: 'scripted/keeper', instruction: 'Keep pets.', openapi: [{ spec: join(dir, 'pets.yaml'), ...extra }] },
      subagents: [],
    },
    't',
  ) as SyndicateYamlConfig;
}
const lastResponse = (req: any) => JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);
function turnFor(config: SyndicateYamlConfig, keeper: ScriptedLlm) {
  const sessionService = new InMemorySessionService();
  return (parts: any[]) => runSyndicateTurn({ config, parts, appName: 'a', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver({ keeper }) }, trace: false });
}

test('in a turn, the agent calls an operation and reads the result', async () => {
  const keeper = new ScriptedLlm('scripted/keeper', (req, n) => (n === 1 ? call('list_pets', {}) : text(`saw ${lastResponse(req)}`)));
  const r = await turnFor(agentConfig({}), keeper)([{ text: 'which pets?' }]);
  assert.equal(r.status, 'completed');
  assert.match(r.text, /"name":"Rex"/);
});

test('a write named under require_approval waits for a person, then runs', async () => {
  const config = agentConfig({ operations: ['listPets', 'createPet'] });
  config.orchestrator.require_approval = ['createPet'];
  validateSyndicateConfig(JSON.parse(JSON.stringify(config)), 't');
  const keeper = new ScriptedLlm('scripted/keeper', (req, n) => (n === 1 ? call('create_pet', { name: 'Ada' }) : text(`done ${lastResponse(req)}`)));
  const turn = turnFor(config, keeper);
  seen.length = 0;
  const first = await turn([{ text: 'add Ada' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.approval?.tool, 'create_pet');
  assert.deepEqual(first.approval?.args, { name: 'Ada' });
  assert.equal(seen.length, 0, 'nothing was sent before the approval');
  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed');
  assert.equal(seen.at(-1)?.method, 'POST');
  assert.match(second.text, /"created":"Ada"/);
});

test('schema: auth is exactly one form from the environment; gates name listed operations', () => {
  const raw = (openapi: unknown, extra: Record<string, unknown> = {}) => ({
    syndicate_name: 'S',
    orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x', openapi, ...extra },
  });
  assert.doesNotThrow(() => validateSyndicateConfig(raw([{ spec: 'a.yaml', auth: { bearer_env: 'TOKEN' } }]), 't'));
  assert.throws(() => validateSyndicateConfig(raw([{ spec: 'a.yaml', auth: { bearer_env: 'TOKEN', api_key: { env: 'K', in: 'header', name: 'X' } } }]), 't'), /exactly one of bearer_env or api_key/);
  assert.throws(() => validateSyndicateConfig(raw([{ spec: 'a.yaml', auth: { bearer_env: 'sk-live-123' } }]), 't'), /environment variable name/);
  assert.throws(() => validateSyndicateConfig(raw([{ spec: 'a.yaml', token: 'x' }]), 't'), /token/);
  assert.doesNotThrow(() => validateSyndicateConfig(raw([{ spec: 'a.yaml', operations: ['createPet'] }], { require_approval: ['createPet'] }), 't'));
  assert.throws(() => validateSyndicateConfig(raw([{ spec: 'a.yaml' }], { require_approval: ['createPet'] }), 't'), /not in this agent's tools or its openapi operations/);
});

test('a relative spec path resolves beside the syndicate file, whatever the working directory', () => {
  const agents = mkdtempSync(join(tmpdir(), 'melch-openapi-agents-'));
  mkdirSync(join(agents, 'specs'));
  writeFileSync(join(agents, 'specs', 'pets.yaml'), spec(base));
  writeFileSync(
    join(agents, 'keeper.yaml'),
    ['syndicate_name: Keeper', 'orchestrator:', '  name: Keeper', '  model: gemini-3.5-flash-lite', '  instruction: x', '  openapi:', '    - spec: specs/pets.yaml'].join('\n'),
  );
  const cfg = loadSyndicate('keeper.yaml', { agentsDir: agents });
  assert.equal(cfg.orchestrator.openapi?.[0]?.spec, join(agents, 'specs', 'pets.yaml'));
});
