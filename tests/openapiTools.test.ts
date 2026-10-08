/**
 * tests/openapiTools.test.ts — an agent's `openapi:` entries
 * (lib/tools/openapiTools.ts): GET-only by default, named operations, auth
 * from the environment, the SSRF guard, bounded results, a turn that calls an
 * operation, a write that waits for approval, spec paths beside the YAML, and
 * the schema; and the parser (lib/tools/openapi/parse.ts): the example specs'
 * declarations pinned, ADK's parse as the reference for its rules, and
 * hostile specs bounded; and the caller (lib/tools/openapi/call.ts): the
 * request ADK's RestApiTool built, as the reference for every argument
 * location and body encoding, the guard before each call and after each
 * redirect, a credential never sent to another origin and never in an
 * error, a log or a span, and one approval gate on both runtimes. A real
 * HTTP server on 127.0.0.1, a scripted fetch for public names; scripted
 * models.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionService, OpenAPIToolset, createRestApiTool, tokenToSchemeCredential, setLogLevel, LogLevel } from '@google/adk';

import { MAX_RESULT_CHARS, buildOpenApiOwnTools, buildOpenApiTools, credentialEnvProblem, isOpenApiTool, toSnake } from '../lib/tools/openapiTools.ts';
import { buildRequest, callOperation } from '../lib/tools/openapi/call.ts';
import type { OpenApiCredential } from '../lib/tools/openapi/call.ts';
import { setHostResolver } from '../lib/net/addressGuard.ts';
import { APPROVAL_TEXTS, createToolContext, toolOf } from '../lib/tools/tool.ts';
import { compileGraph } from '../lib/compile.ts';
import { flushTracing, onSpanEnd } from '../lib/observability/tracer.ts';
import { readFileSync as readText } from 'node:fs';
import { MAX_SPEC_BYTES, adkSnake, operationNamed, parseOpenApiDocument, parseOpenApiSpec } from '../lib/tools/openapi/parse.ts';
import type { OpenApiOperation } from '../lib/tools/openapi/parse.ts';
import { contractToolDeclaration } from '../lib/models/schemaNormalize.ts';
import type { ToolDeclaration } from '../lib/models/contract.ts';
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
      if (req.url === '/moved') {
        res.writeHead(302, { Location: '/pets' });
        return res.end();
      }
      if (req.url === '/escape') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/iam/' });
        return res.end();
      }
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
  writeFileSync(join(dir, 'hops.yaml'), `openapi: 3.0.0
info: { title: Hops, version: "1" }
servers: [{ url: "${base}" }]
paths:
  /moved:
    get: { operationId: getMoved, summary: Moved to the pets, responses: { "200": { description: ok } } }
  /escape:
    get: { operationId: getEscape, summary: Redirects to the metadata service, responses: { "200": { description: ok } } }
`);
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

test('auth may never name one of the framework\'s own settings (the database, a provider key, an A2A secret)', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only-value';
  await assert.rejects(
    buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], auth: { bearer_env: 'SUPABASE_SERVICE_ROLE_KEY' } }, dir),
    /SUPABASE_SERVICE_ROLE_KEY is one of the framework's own settings and may not be sent to an API/,
  );
  // Every variable .env.example documents is the framework's own: none may become a credential.
  const documented = [...readText('.env.example', 'utf-8').matchAll(/^#?\s?([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]!);
  assert.ok(documented.length > 50);
  const allowed = documented.filter((name) => credentialEnvProblem(name, {}) === null);
  assert.deepEqual(allowed, [], `framework variables an OpenAPI auth could read: ${allowed.join(', ')}`);
  assert.equal(credentialEnvProblem('WEATHER_API_KEY', {}), null, "an API's own variable is fine");
});

test('OPENAPI_CREDENTIAL_ENVS turns the rule into an exact allowlist', () => {
  const env = { OPENAPI_CREDENTIAL_ENVS: 'PETS_TOKEN, OPENAI_API_KEY' };
  assert.equal(credentialEnvProblem('PETS_TOKEN', env), null);
  assert.equal(credentialEnvProblem('OPENAI_API_KEY', env), null, 'an operator may allow a provider key on purpose');
  assert.match(credentialEnvProblem('WEATHER_API_KEY', env)!, /not in OPENAPI_CREDENTIAL_ENVS/);
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

test('a redirect on the same origin is followed; one to the metadata service is refused, even with ALLOW_PRIVATE_OPENAPI', async () => {
  const [moved, escape] = await buildOpenApiTools({ spec: 'hops.yaml', operations: ['getMoved', 'getEscape'] }, dir);
  seen.length = 0;
  assert.deepEqual(await run(moved, {}), [{ id: 'p1', name: 'Rex' }]);
  assert.deepEqual(seen.map((r) => r.url), ['/moved', '/pets'], 'the hop was followed by hand');
  const refused = String(((await run(escape, {})) as any).error);
  assert.match(refused, /get_escape failed: redirect refused: refusing 169\.254\.169\.254/);
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
  assert.throws(() => validateSyndicateConfig(raw([{ spec: 'a.yaml' }], { require_approval: ['createPet'] }), 't'), /not in this agent's tools, its openapi operations or its mcp_tools/);
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

// ── The parser (lib/tools/openapi/parse.ts, ADR 0063) ───────────────────────

const EXAMPLE_SPECS = join(import.meta.dirname, '..', 'config', 'agents', 'examples', 'specs');

/**
 * What the model received for every example spec before the engine owned the
 * parser (contractToolDeclaration of ADK's OpenAPIToolset tools, captured on
 * main). The parser must keep declaring exactly this.
 */
const PINNED_DECLARATIONS: Record<string, ToolDeclaration[]> = {
  'open-meteo-forecast.json': [
    {
      name: 'get_forecast',
      description: 'The weather now and the daily forecast for a latitude and longitude.',
      parameters: {
        type: 'object',
        properties: {
          latitude: { type: 'number' },
          longitude: { type: 'number' },
          current: { type: 'string' },
          daily: { type: 'string' },
          forecast_days: { type: 'integer' },
          timezone: { type: 'string' },
        },
        required: ['latitude', 'longitude'],
      },
    },
  ],
  'open-meteo-geocoding.json': [
    {
      name: 'find_place',
      description: 'Find a place by name. Returns matching places with their latitude, longitude, country and timezone; the first result is the most likely.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, count: { type: 'integer' }, language: { type: 'string' } },
        required: ['name'],
      },
    },
  ],
};

test('every example spec declares exactly what the model received before (pinned)', async () => {
  const specs = readdirSync(EXAMPLE_SPECS).sort();
  assert.deepEqual(specs, Object.keys(PINNED_DECLARATIONS).sort(), 'a new example spec needs its declarations pinned here');
  for (const file of specs) {
    const parsed = parseOpenApiSpec(readText(join(EXAMPLE_SPECS, file), 'utf-8'), 'json');
    assert.deepEqual(parsed.map((o) => o.declaration), PINNED_DECLARATIONS[file], file);
    const tools = await buildOpenApiTools({ spec: file }, EXAMPLE_SPECS);
    assert.deepEqual(tools.map((t) => contractToolDeclaration(t)), PINNED_DECLARATIONS[file], `${file}: the built tools`);
    const prefixed = await buildOpenApiTools({ spec: file, prefix: 'om' }, EXAMPLE_SPECS);
    assert.deepEqual(names(prefixed), PINNED_DECLARATIONS[file]!.map((d) => `om_${d.name}`).sort());
  }
});

/** A spec that exercises the parser's rules: refs and a cycle, every body shape, odd types, keywords, dedupe, server variables, security. */
const SINK = `openapi: 3.0.3
info: { title: Sink, version: "1" }
servers: [{ url: "https://{region}.api.example.com/v1", variables: { region: { default: eu } } }]
security: [{ key: [] }]
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Key }
  schemas:
    Pet:
      type: object
      title: Pet
      required: [name]
      properties:
        name: { type: string, maxLength: 40, format: uuid, default: x, example: Rex, description: The pet's name }
        tags: { type: array, items: { type: string, enum: [a, b] } }
        owner: { $ref: '#/components/schemas/Owner' }
        nickname: { type: string, nullable: true }
        kind: { type: [string, "null"] }
        weird: { type: Text }
        extra: { type: object, additionalProperties: { type: string } }
        meta: { type: object }
        choice: { anyOf: [{ type: string }, { type: integer }] }
        either: { oneOf: [{ type: string }, { type: integer }] }
        tuple: { type: array, items: [{ type: string }] }
        born: { type: string, example: 2024-01-01 }
        max_items_snake: { type: array, max_items: 3, MinItems: 1, items: { type: string } }
    Owner:
      type: object
      properties:
        pets: { type: array, items: { $ref: '#/components/schemas/Pet' } }
    Node:
      type: object
      properties:
        label: { type: string }
        child: { $ref: '#/components/schemas/Node' }
paths:
  /pets:
    parameters: [{ name: X-Trace, in: header, schema: { type: string } }]
    get:
      operationId: listPets
      summary: List
      description: List all the pets
      parameters:
        - { name: limit, in: query, description: How many, schema: { type: integer, minimum: 1, maximum: 100 } }
        - { name: class, in: query, schema: { type: string } }
        - { name: pageToken, in: query, required: true, schema: { type: string } }
        - { $ref: '#/components/parameters/Missing' }
    post:
      operationId: createPet
      security: [{ bearer: [] }]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
  /pets/{petId}:
    get: { parameters: [{ name: petId, in: path, required: true, schema: { type: string } }] }
    put:
      operationId: getHTTPStatusForPet
      parameters: [{ name: petId, in: path, required: true, schema: { type: string } }, { name: pet_id, in: query, schema: { type: string } }]
      requestBody: { content: { application/json: { schema: { type: array, items: { type: integer } } } } }
    delete: { operationId: deletePet }
    patch:
      operationId: patchPet
      requestBody: { description: raw, content: { text/plain: { schema: { type: string } } } }
  /things:
    post:
      operationId: makeThing
      requestBody: { content: { application/json: { schema: { type: object } } } }
    head:
      operationId: import
      parameters: [{ name: in, in: query, schema: { type: boolean } }, { name: "a.b", in: query, schema: { type: number } }]
  /trees:
    post:
      operationId: plantAVeryLongOperationIdThatGoesOnAndOnPastTheSixtyCharacterLimitOfAToolName
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Node' } } } }
`;

/** ADK's own parse of a spec, the reference the engine's parser reproduces (until ADK leaves, ADR 0045). */
async function adkReference(text: string, specType: 'json' | 'yaml', prefix?: string) {
  const toolset = new OpenAPIToolset({ specStr: text, specType, ...(prefix ? { prefix } : {}) });
  return ((await toolset.getTools()) as any[]).map((t) => ({
    name: t.name,
    operationId: t.operation.operationId,
    method: t.endpoint.method,
    path: t.endpoint.path,
    baseUrl: t.endpoint.baseUrl,
    authScheme: t.authScheme,
    parameters: t.operationParser.getParameters().map((p: any) => ({ name: p.name, originalName: p.originalName, location: p.paramLocation, required: p.required, schema: p.paramSchema })),
    declaration: contractToolDeclaration(t),
  }));
}
const ours = (ops: OpenApiOperation[]) =>
  ops.map((o) => ({
    name: o.name,
    operationId: o.operationId,
    method: o.method,
    path: o.path,
    baseUrl: o.baseUrl,
    authScheme: o.authScheme,
    parameters: o.parameters.map((p) => ({ name: p.name, originalName: p.originalName, location: p.location, required: p.required, schema: p.schema })),
    declaration: o.declaration,
  }));

function sinkDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'melch-openapi-sink-'));
  writeFileSync(join(d, 'sink.yaml'), SINK);
  return d;
}

test('the parser names, splits and declares every operation as ADK did', async () => {
  const cases: Array<[string, string, 'json' | 'yaml', string?]> = [
    ['sink', SINK, 'yaml'],
    ['sink, prefixed', SINK, 'yaml', 'zoo'],
    ['pets', spec('https://pets.example.com'), 'yaml'],
    ...readdirSync(EXAMPLE_SPECS).map((f) => [f, readText(join(EXAMPLE_SPECS, f), 'utf-8'), 'json'] as [string, string, 'json']),
  ];
  for (const [label, text, format, prefix] of cases) {
    const expected = await adkReference(text, format, prefix);
    const actual = ours(parseOpenApiSpec(text, format, prefix ? { prefix } : {}));
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), label);
  }
  const sink = parseOpenApiSpec(SINK, 'yaml');
  assert.deepEqual(sink.map((o) => o.name), [
    'list_pets', 'create_pet', 'pets_pet_id_get', 'get_http_status_for_pet', 'delete_pet', 'patch_pet', 'make_thing', 'param_import',
    'plant_a_very_long_operation_id_that_goes_on_and_on_past_the_',
  ]);
  // The built tools are own Tools over the parse, through toFunctionTool on the ADK path: the declaration a model reads is the parser's.
  const built = await buildOpenApiTools({ spec: 'sink.yaml', operations: sink.map((o) => o.operationId) }, sinkDir());
  assert.deepEqual(built.map((t) => contractToolDeclaration(t)), sink.map((o) => o.declaration));
});

test('operations are named by operationId, tool name or snake_case, with or without the prefix', () => {
  const [op] = parseOpenApiSpec(SINK, 'yaml', { prefix: 'zoo' }).filter((o) => o.operationId === 'getHTTPStatusForPet');
  for (const configured of ['getHTTPStatusForPet', 'zoo_get_http_status_for_pet', 'get_http_status_for_pet']) assert.ok(operationNamed(configured, op!, 'zoo'), configured);
  assert.ok(!operationNamed('listPets', op!, 'zoo'));
});

test('the snake_case helpers match the regular expressions they replace, in linear time', () => {
  const oldToSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  const oldAdkSnake = (s: string) =>
    s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const alphabet = ['a', 'b', 'Z', 'Q', '9', '0', '_', '-', '.', ' ', '{', 'é'];
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const samples = ['getHTTPStatus', 'HTTPServer2Go', 'ABc', 'aBC', '__x__', 'pets/{petId}_get', 'XMLHttpRequest', 'A', ''];
  for (let i = 0; i < 5000; i++) samples.push(Array.from({ length: 1 + rand(12) }, () => alphabet[rand(alphabet.length)]).join(''));
  for (const s of samples) {
    assert.equal(toSnake(s), oldToSnake(s), `toSnake(${JSON.stringify(s)})`);
    assert.equal(adkSnake(s), oldAdkSnake(s), `adkSnake(${JSON.stringify(s)})`);
  }
  const hostile = 'A'.repeat(200_000) + '1' + '_'.repeat(200_000) + 'x';
  const started = Date.now();
  adkSnake(hostile);
  toSnake(hostile);
  assert.ok(Date.now() - started < 1000, 'linear on a hostile name');
});

test('a hostile spec is refused with a readable error, never a hang or a crash', () => {
  // Too large.
  assert.throws(() => parseOpenApiSpec(' '.repeat(MAX_SPEC_BYTES + 1), 'json', { source: 'big.json' }), /openapi big\.json: the spec is larger than/);
  // A YAML alias bomb.
  const letter = (i: number) => String.fromCharCode(97 + i);
  const bomb = [`a: &a [${Array(10).fill('"x"').join(',')}]`, ...Array.from({ length: 9 }, (_, i) => `${letter(i + 1)}: &${letter(i + 1)} [${Array(10).fill(`*${letter(i)}`).join(',')}]`)].join('\n');
  assert.throws(() => parseOpenApiSpec(`${bomb}\npaths: {}\n`, 'yaml'), /not valid YAML: Excessive alias count/);
  // A $ref expansion bomb: each level uses the one below twice.
  const schemas: Record<string, unknown> = { s0: { type: 'string' } };
  for (let i = 1; i <= 25; i++) schemas[`s${i}`] = { type: 'object', properties: { l: { $ref: `#/components/schemas/s${i - 1}` }, r: { $ref: `#/components/schemas/s${i - 1}` } } };
  const refBomb = {
    openapi: '3.0.0',
    paths: { '/x': { post: { operationId: 'x', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/s25' } } } } } } },
    components: { schemas },
  };
  assert.throws(() => parseOpenApiDocument(refBomb, { source: 'bomb.json' }), /more than 1000000 values/);
  // Deep nesting.
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 300; i++) deep = { type: 'object', properties: { n: deep } };
  assert.throws(() => parseOpenApiDocument({ openapi: '3.0.0', paths: { '/d': { post: { operationId: 'd', requestBody: { content: { 'application/json': { schema: deep } } } } } } }), /deeper than 128/);
  // A long chain of refs.
  // Listed from the far end, so resolving the first one walks the whole chain.
  const chain: Record<string, unknown> = {};
  for (let i = 500; i >= 1; i--) chain[`c${i}`] = { $ref: `#/c${i - 1}` };
  chain.c0 = { type: 'string' };
  assert.throws(() => parseOpenApiDocument({ openapi: '3.0.0', ...chain, paths: { '/c': { get: { operationId: 'c', parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/c500' } }] } } } }), /deeper than 128/);
  // An external ref, and a document that is not one.
  assert.throws(() => parseOpenApiDocument({ openapi: '3.0.0', paths: { '/e': { get: { operationId: 'e', parameters: [{ $ref: 'other.yaml#/p' }] } } } }), /external references are not supported/);
  assert.throws(() => parseOpenApiSpec('"just a string"', 'json'), /not an OpenAPI document/);
  assert.throws(() => parseOpenApiSpec('{', 'json', { source: 'bad.json' }), /openapi bad\.json: the spec is not valid JSON/);
});

test('a ref cycle ends where it closes, and a __proto__ key stays a key', () => {
  const [plant] = parseOpenApiSpec(SINK, 'yaml').filter((o) => o.path === '/trees');
  const child = (plant!.declaration.parameters as any).properties.child;
  // Node was resolved where components lists it, so its self-reference is already cut: an empty object.
  assert.deepEqual(child, { type: 'object', properties: { dummy_DO_NOT_GENERATE: { type: 'string' } } });
  const [op] = parseOpenApiSpec('{"openapi":"3.0.0","paths":{"/p":{"post":{"operationId":"p","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"__proto__":{"type":"string","polluted":true}}}}}}}}}}', 'json');
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(op!.parameters.map((p) => p.name), ['proto']);
});

// ── The caller (lib/tools/openapi/call.ts, ADR 0067) ────────────────────────

test('a spec that is not OpenAPI 3.x is refused with a readable error', () => {
  assert.throws(() => parseOpenApiSpec('{"swagger":"2.0","paths":{}}', 'json', { source: 'old.json' }), /openapi old\.json: the spec is Swagger "2\.0" \(OpenAPI 2\); only OpenAPI 3\.x is supported/);
  assert.throws(() => parseOpenApiSpec('{"paths":{}}', 'json'), /the spec has no `openapi` version; only OpenAPI 3\.x is supported/);
  assert.throws(() => parseOpenApiSpec('{"openapi":"4.0.0","paths":{}}', 'json'), /the spec is OpenAPI "4\.0\.0"; only OpenAPI 3\.x is supported/);
  assert.throws(() => parseOpenApiSpec('{"openapi":"30.1","paths":{}}', 'json'), /only OpenAPI 3\.x/);
  assert.equal(parseOpenApiSpec('openapi: 3.1.0\npaths: {}\n', 'yaml').length, 0);
  assert.equal(parseOpenApiSpec('openapi: 3.0\npaths: {}\n', 'yaml').length, 0, 'an unquoted YAML 3.0 reads as the number 3');
});

test('a $ref is a JSON pointer: ~1 is / and ~0 is ~', () => {
  const [op] = parseOpenApiDocument({
    openapi: '3.0.0',
    paths: {
      '/a/{id}': { get: { operationId: 'a', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 5 } }] } },
      '/b': { get: { operationId: 'b', parameters: [{ $ref: '#/paths/~1a~1{id}/get/parameters/0' }, { name: 'q', in: 'query', schema: { $ref: '#/components/schemas/a~0b' } }] } },
    },
    components: { schemas: { 'a~b': { type: 'integer' } } },
  }).filter((o) => o.operationId === 'b');
  assert.deepEqual(op!.parameters.map((p) => [p.name, p.location, p.schema]), [
    ['id', 'path', { type: 'string', maxLength: 5 }],
    ['q', 'query', { type: 'integer' }],
  ]);
});

/** Every argument location and body encoding RestApiTool handles. */
const SHAPES = `openapi: 3.0.0
info: { title: Shapes, version: "1" }
servers: [{ url: "https://api.example.com/v1/" }]
paths:
  /items/{itemId}/parts/{part}:
    get:
      operationId: getPart
      parameters:
        - { name: itemId, in: path, required: true, schema: { type: string } }
        - { name: part, in: path, required: true, schema: { type: integer } }
        - { name: q, in: query, schema: { type: string } }
        - { name: tags, in: query, schema: { type: array, items: { type: string } } }
        - { name: empty, in: query, schema: { type: string } }
        - { name: X-Trace, in: header, schema: { type: string } }
        - { name: session, in: cookie, schema: { type: string } }
        - { name: theme, in: cookie, schema: { type: string } }
  /search?fixed=1:
    get:
      operationId: search
      parameters: [{ name: q, in: query, schema: { type: string } }]
  /json:
    post:
      operationId: postJson
      requestBody: { content: { application/json: { schema: { type: object, properties: { name: { type: string }, n: { type: integer } } } } } }
  /vnd:
    post:
      operationId: postVnd
      requestBody: { content: { application/vnd.api+json: { schema: { type: array, items: { type: integer } } } } }
  /form:
    post:
      operationId: postForm
      requestBody: { content: { application/x-www-form-urlencoded: { schema: { type: object, properties: { a: { type: string }, b: { type: string } } } } } }
  /multi:
    post:
      operationId: postMulti
      requestBody: { content: { multipart/form-data: { schema: { type: object, properties: { a: { type: string }, n: { type: integer } } } } } }
  /octet:
    put:
      operationId: putOctet
      requestBody: { content: { application/octet-stream: { schema: { type: string } } } }
  /text:
    patch:
      operationId: patchText
      requestBody: { content: { text/plain: { schema: { type: string } } } }
  /whole:
    post:
      operationId: postWhole
      requestBody: { content: { application/json: { schema: { type: object } } } }
`;

type Sent = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

/** A fetch that records each request as plain data and answers from `answer`. */
function recordingFetch(answer: (url: string) => Response = () => Response.json({ ok: true })) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: string | undefined;
    if (init?.body instanceof FormData) body = JSON.stringify([...init.body.entries()]);
    else if (init?.body !== undefined && init?.body !== null) body = String(init.body);
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    return answer(String(input));
  }) as typeof fetch;
  return { sent, fetchImpl };
}

/** Run `fn` with globalThis.fetch replaced and the example names resolving to a public address. */
async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  setHostResolver(async (host) => {
    if (host.endsWith('.example.com') || host.endsWith('.example.net')) return [{ address: '93.184.216.34' }];
    throw new Error('ENOTFOUND');
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    setHostResolver();
  }
}

/** ADK's RestApiTool for a parsed operation, as the engine built it before it owned the call: the reference. */
function referenceTool(op: OpenApiOperation, credential?: OpenApiCredential) {
  const tool = createRestApiTool({
    name: op.name,
    description: op.description,
    endpoint: { baseUrl: op.baseUrl, path: op.path, method: op.method as any },
    operation: op.operation as any,
    authScheme: op.authScheme as any,
    parameters: op.parameters.map((p) => ({ name: p.name, originalName: p.originalName, paramLocation: p.location, paramSchema: p.schema as any, description: p.description as string, required: p.required })),
  });
  if (credential) {
    const [scheme, cred] =
      credential.kind === 'bearer'
        ? tokenToSchemeCredential('oauth2Token', undefined, undefined, credential.token)
        : tokenToSchemeCredential('apikey', credential.in, credential.name, credential.value);
    tool.configureAuthScheme(scheme as any);
    tool.configureAuthCredential(cred as any);
  }
  return tool;
}

/** What the reference sent and answered for the arguments, against `answer`. */
async function referenceCall(op: OpenApiOperation, args: Record<string, unknown>, credential?: OpenApiCredential, answer?: (url: string) => Response) {
  const tool = referenceTool(op, credential);
  const { sent, fetchImpl } = recordingFetch(answer);
  const state = new Map<string, unknown>();
  const toolContext = { state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v), has: (k: string) => state.has(k) }, getAuthResponse: () => undefined, requestCredential: () => {} } as any;
  const result = await withFetch(fetchImpl, () => tool.runAsync({ args, toolContext }));
  return { sent, result };
}

test('the request is the one ADK\'s RestApiTool built, for every argument location, body encoding and credential', async () => {
  const ops = parseOpenApiSpec(SHAPES, 'yaml');
  const byId = (id: string) => ops.find((o) => o.operationId === id)!;
  const cases: Array<[string, Record<string, unknown>, OpenApiCredential?]> = [
    ['getPart', { item_id: 'a/b?c d', part: 7, q: 'x y&z', tags: ['a', 'b'], empty: '', x_trace: 't-1', session: 's 1;', theme: 'dark', ignored: 'never sent' }],
    ['getPart', { item_id: 'ü', part: 0, q: null }, { kind: 'api_key', in: 'query', name: 'api_key', value: 'k&y=1' }],
    ['search', { q: 'cats' }, { kind: 'api_key', in: 'query', name: 'key', value: 'k1' }],
    ['search', { q: 'cats' }, { kind: 'api_key', in: 'header', name: 'X-Api-Key', value: 'k2' }],
    ['search', {}, { kind: 'bearer', token: 'tok' }],
    ['postJson', { name: 'Ada', n: 3 }],
    ['postJson', {}],
    ['postVnd', { body: [1, 2] }],
    ['postForm', { a: '1', b: 'two words' }],
    ['postMulti', { a: 'x', n: 2 }],
    ['putOctet', { body: 'raw bytes' }],
    ['patchText', { body: 42 }],
    ['postWhole', { body: { free: 'form' } }],
  ];
  for (const [id, args, credential] of cases) {
    const op = byId(id);
    const reference = await referenceCall(op, args, credential);
    const { sent, fetchImpl } = recordingFetch();
    const result = await withFetch(fetchImpl, () => callOperation(op, args, { credential }));
    const label = `${id} ${JSON.stringify(args)}`;
    assert.equal(sent.length, 1, label);
    assert.deepEqual(sent, reference.sent, label);
    assert.deepEqual(result, reference.result, label);
  }
  assert.equal(buildRequest(byId('getPart'), { item_id: 'a/b?c d', part: 7 }).url, 'https://api.example.com/v1/items/a%2Fb%3Fc%20d/parts/7');
});

test('the answer reads as RestApiTool\'s did: JSON, else { text }, and its error text for a status of 400 or more', async () => {
  const [op] = parseOpenApiSpec(SHAPES, 'yaml').filter((o) => o.operationId === 'search');
  const answers: Array<() => Response> = [
    () => Response.json([1, 2]),
    () => new Response('plain words', { status: 200 }),
    () => new Response(null, { status: 204 }),
    () => new Response('{"error":"no such thing"}', { status: 404 }),
    () => new Response('boom', { status: 500 }),
  ];
  for (const answer of answers) {
    const ours = recordingFetch(answer);
    const result = await withFetch(ours.fetchImpl, () => callOperation(op!, { q: 'x' }));
    const reference = await referenceCall(op!, { q: 'x' }, undefined, answer);
    assert.deepEqual(result, reference.result);
  }
  // A dot segment never reaches the network.
  const [part] = parseOpenApiSpec(SHAPES, 'yaml').filter((o) => o.operationId === 'getPart');
  const { sent, fetchImpl } = recordingFetch();
  for (const dot of ['.', '..']) {
    const result = await withFetch(fetchImpl, () => callOperation(part!, { item_id: dot, part: 1 }));
    assert.match(String((result as any).error), /get_part failed: Invalid value for path parameter 'itemId': relative path segments/);
  }
  assert.equal(sent.length, 0);
});

test('the guard runs before every call: a public name that resolves to a private or link-local address is never called', async () => {
  delete process.env.ALLOW_PRIVATE_OPENAPI;
  try {
    for (const [address, reason] of [['10.0.0.7', /private IPv4/], ['169.254.169.254', /link-local\/metadata IPv4/], ['fd00::1', /unique-local IPv6/], ['::ffff:127.0.0.1', /loopback IPv4/]] as const) {
      const [tool] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], base_url: 'https://pets.example.com' }, dir);
      const { sent, fetchImpl } = recordingFetch();
      const original = globalThis.fetch;
      globalThis.fetch = fetchImpl;
      setHostResolver(async () => [{ address: '93.184.216.34' }, { address }]);
      try {
        const result = (await run(tool, {})) as { error: string };
        assert.match(result.error, /^list_pets was not called: refusing pets\.example\.com: resolves to a /);
        assert.match(result.error, reason);
        assert.equal(sent.length, 0, `${address}: nothing was sent`);
      } finally {
        globalThis.fetch = original;
        setHostResolver();
      }
    }
  } finally {
    process.env.ALLOW_PRIVATE_OPENAPI = 'true';
  }
});

test('after a redirect: a hop to a private address or a name that resolves to one is refused, never fetched', async () => {
  delete process.env.ALLOW_PRIVATE_OPENAPI;
  try {
    for (const location of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'https://inside.example.net/admin']) {
      const [tool] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], base_url: 'https://pets.example.com' }, dir);
      const { sent, fetchImpl } = recordingFetch((url) => (new URL(url).host === 'pets.example.com' ? new Response(null, { status: 302, headers: { Location: location } }) : Response.json('reached')));
      const original = globalThis.fetch;
      globalThis.fetch = fetchImpl;
      setHostResolver(async (host) => [{ address: host === 'inside.example.net' ? '192.168.1.10' : '93.184.216.34' }]);
      try {
        const result = (await run(tool, {})) as { error: string };
        assert.match(result.error, /^list_pets failed: redirect refused: refusing /, location);
        assert.deepEqual(sent.map((s) => s.url), ['https://pets.example.com/pets'], `${location}: only the first request was sent`);
      } finally {
        globalThis.fetch = original;
        setHostResolver();
      }
    }
  } finally {
    process.env.ALLOW_PRIVATE_OPENAPI = 'true';
  }
});

test('a credential is never sent to a host it is not for: a redirect to another origin drops it, one on the same origin keeps it', async () => {
  process.env.PETS_TOKEN = 'tok-cross-origin-secret';
  process.env.PETS_KEY = 'key-cross-origin-secret';
  try {
    for (const auth of [{ bearer_env: 'PETS_TOKEN' }, { api_key: { env: 'PETS_KEY', in: 'header' as const, name: 'X-Api-Key' } }]) {
      const [tool] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], base_url: 'https://pets.example.com', auth }, dir);
      const { sent, fetchImpl } = recordingFetch((url) => {
        if (url === 'https://pets.example.com/pets') return new Response(null, { status: 302, headers: { Location: '/v2/pets' } });
        if (url === 'https://pets.example.com/v2/pets') return new Response(null, { status: 307, headers: { Location: 'https://cdn.example.net/pets.json' } });
        return Response.json([{ id: 'p1' }]);
      });
      const result = await withFetch(fetchImpl, () => run(tool, {}));
      assert.deepEqual(result, [{ id: 'p1' }]);
      assert.deepEqual(sent.map((s) => s.url), ['https://pets.example.com/pets', 'https://pets.example.com/v2/pets', 'https://cdn.example.net/pets.json']);
      const carries = (s: Sent) => JSON.stringify(s.headers).includes('cross-origin-secret');
      assert.deepEqual(sent.map(carries), [true, true, false], JSON.stringify(auth));
    }
  } finally {
    delete process.env.PETS_TOKEN;
    delete process.env.PETS_KEY;
  }
});

test('a credential the allowlist refuses never reaches a tool, and its value is never in the compile error', async () => {
  process.env.OPENAPI_CREDENTIAL_ENVS = 'PETS_TOKEN';
  process.env.OTHER_KEY = 'other-secret-value';
  try {
    await assert.rejects(buildOpenApiTools({ spec: 'pets.yaml', auth: { bearer_env: 'OTHER_KEY' } }, dir), (err: Error) => {
      assert.match(err.message, /OTHER_KEY is not in OPENAPI_CREDENTIAL_ENVS \(PETS_TOKEN\)/);
      assert.doesNotMatch(err.message, /other-secret-value/);
      return true;
    });
  } finally {
    delete process.env.OPENAPI_CREDENTIAL_ENVS;
    delete process.env.OTHER_KEY;
  }
});

test('a credential is never in an error the model reads: a fetch error quoting the URL, or an API echoing the key', async () => {
  process.env.PETS_KEY = 'k3y/with spaces+and&more';
  try {
    const [tool] = await buildOpenApiTools({ spec: 'pets.yaml', operations: ['listPets'], base_url: 'https://pets.example.com', auth: { api_key: { env: 'PETS_KEY', in: 'query', name: 'key' } } }, dir);
    const thrower = (async (input: string | URL | Request) => {
      throw new TypeError(`Failed to parse URL from ${String(input)}`);
    }) as typeof fetch;
    const echo = recordingFetch((url) => new Response(`invalid key ${new URL(url).searchParams.get('key')} (sent as ${url})`, { status: 401 }));
    for (const fetchImpl of [thrower, echo.fetchImpl]) {
      const result = JSON.stringify(await withFetch(fetchImpl, () => run(tool, {})));
      assert.match(result, /\[redacted\]/);
      assert.doesNotMatch(result, /k3y/);
    }
    assert.equal(new URL(echo.sent[0]!.url).searchParams.get('key'), 'k3y/with spaces+and&more', 'the API itself received the key');
  } finally {
    delete process.env.PETS_KEY;
  }
});

test('a credential is never in a log, a span or an event of a turn', async () => {
  process.env.PETS_TOKEN = 'tok-never-logged-7f3a';
  const lines: string[] = [];
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = levels.map((level) => console[level]);
  for (const level of levels) console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const spans: string[] = [];
  const off = onSpanEnd((span) => spans.push(JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events })));
  try {
    const config = agentConfig({ operations: ['listPets', 'getPet'], auth: { bearer_env: 'PETS_TOKEN' } });
    const keeper = new ScriptedLlm('scripted/keeper', (req, n) => (n === 1 ? call('list_pets', {}) : n === 2 ? call('get_pet', { pet_id: 'p1' }) : text(`saw ${lastResponse(req)}`)));
    const sessionService = new InMemorySessionService();
    const r = await runSyndicateTurn({ config, parts: [{ text: 'which pets?' }], appName: 'a', userId: 'u', sessionId: 's-log', sessionService, compile: { resolveModel: scriptedResolver({ keeper }), log: (m) => void lines.push(m) } });
    await flushTracing();
    assert.equal(r.status, 'completed');
    assert.equal(seen.at(-1)?.auth, 'Bearer tok-never-logged-7f3a', 'the API received the token');
    assert.ok(spans.length > 0, 'the turn was traced');
    const session = await sessionService.getSession({ appName: 'a', userId: 'u', sessionId: 's-log' });
    for (const [where, written] of [['logs', lines.join('\n')], ['spans', spans.join('\n')], ['events', JSON.stringify(session)]] as const) {
      assert.doesNotMatch(written, /tok-never-logged-7f3a/, where);
    }
  } finally {
    off();
    levels.forEach((level, i) => (console[level] = originals[i]!));
    delete process.env.PETS_TOKEN;
  }
});

test('a spec that requires a credential is never called without one', async () => {
  const d = mkdtempSync(join(tmpdir(), 'melch-openapi-secured-'));
  writeFileSync(join(d, 'secured.yaml'), `openapi: 3.0.0
info: { title: S, version: "1" }
servers: [{ url: "${base}" }]
security: [{ key: [] }]
components: { securitySchemes: { key: { type: apiKey, in: header, name: X-Key } } }
paths:
  /pets: { get: { operationId: listPets, responses: { "200": { description: ok } } } }
`);
  const [tool] = await buildOpenApiTools({ spec: 'secured.yaml' }, d);
  seen.length = 0;
  assert.match(String(((await run(tool, {})) as any).error), /list_pets was not called: the API's spec requires a credential \(apiKey\), and this agent's openapi entry sets no auth/);
  assert.equal(seen.length, 0);
  process.env.PETS_KEY = 'key-789';
  try {
    const [keyed] = await buildOpenApiTools({ spec: 'secured.yaml', auth: { api_key: { env: 'PETS_KEY', in: 'header', name: 'X-Api-Key' } } }, d);
    assert.deepEqual(((await run(keyed, {})) as any[])[0], { id: 'p1', name: 'Rex' });
    assert.equal(seen.at(-1)?.key, 'key-789');
  } finally {
    delete process.env.PETS_KEY;
  }
});

test('approval: an OpenAPI operation takes the one gate registry tools take, on both runtimes, and a refusal sends nothing', async () => {
  // The own Tool is marked, so require_approval may name an operation by its operationId.
  const [own] = await buildOpenApiOwnTools({ spec: 'pets.yaml', operations: ['createPet'] }, dir);
  assert.ok(isOpenApiTool(own));
  const config = agentConfig({ operations: ['listPets', 'createPet'] });
  config.orchestrator.require_approval = ['createPet'];
  const agent = (await compileGraph(config, { resolveModel: scriptedResolver({ keeper: new ScriptedLlm('scripted/keeper', () => text('x')) }) })) as any;
  const gated = agent.tools.find((t: any) => t.name === 'create_pet');
  const open = agent.tools.find((t: any) => t.name === 'list_pets');
  assert.equal(gated.requireConfirmation, true, 'the ADK runtime raises adk_request_confirmation through FunctionTool');
  assert.equal(toolOf(gated)?.requiresApproval, true, 'the native runtime reads the gated Tool back');
  assert.notEqual(toolOf(open)?.requiresApproval, true, 'an operation not named stays ungated');

  // The own gate: a first call asks and sends nothing; a refusal sends nothing; an approval runs it.
  seen.length = 0;
  const first = createToolContext();
  assert.deepEqual(await toolOf(gated)!.execute({ name: 'Bo' }, first), { error: APPROVAL_TEXTS.pending });
  assert.equal(first.confirmationRequest?.hint, APPROVAL_TEXTS.hint('create_pet'));
  assert.deepEqual(await toolOf(gated)!.execute({ name: 'Bo' }, createToolContext({ confirmation: { confirmed: false } })), { error: APPROVAL_TEXTS.rejected });
  assert.equal(seen.length, 0, 'nothing was sent before an approval');
  assert.deepEqual(await toolOf(gated)!.execute({ name: 'Bo' }, createToolContext({ confirmation: { confirmed: true } })), { created: 'Bo' });
  assert.equal(seen.at(-1)?.method, 'POST');
});

test('a refused approval in a turn sends nothing', async () => {
  const config = agentConfig({ operations: ['createPet'] });
  config.orchestrator.require_approval = ['createPet'];
  const keeper = new ScriptedLlm('scripted/keeper', (req, n) => (n === 1 ? call('create_pet', { name: 'Eve' }) : text(`done ${lastResponse(req)}`)));
  const turn = turnFor(config, keeper);
  seen.length = 0;
  const first = await turn([{ text: 'add Eve' }]);
  assert.equal(first.status, 'input-required');
  const second = await turn([approvalResponsePart(first.approval!.id, false)]);
  assert.equal(second.status, 'completed');
  assert.equal(seen.length, 0, 'a refused call is never sent');
  assert.match(second.text, /rejected/);
});

test('no runtime code imports ADK\'s OpenAPI classes', () => {
  const files = (readdirSync(join(import.meta.dirname, '..', 'lib'), { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
  const adkImports = (source: string) => [...source.matchAll(/\bimport\s[^;]*;/g)].map((m) => m[0]).filter((s) => s.includes('@google/adk')).join('\n');
  const named = /\b(OpenAPIToolset|RestApiTool|createRestApiTool|tokenToSchemeCredential)\b/;
  const offenders = files.filter((f) => named.test(adkImports(readText(join(import.meta.dirname, '..', 'lib', f), 'utf-8'))));
  assert.deepEqual(offenders, []);
  assert.ok(named.test(adkImports("import {\n  BaseTool,\n  createRestApiTool,\n} from '@google/adk';")), 'a multi-line import is read whole');
});
