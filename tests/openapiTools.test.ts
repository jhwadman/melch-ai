/**
 * tests/openapiTools.test.ts — an agent's `openapi:` entries
 * (lib/tools/openapiTools.ts): GET-only by default, named operations, auth
 * from the environment, the SSRF guard, bounded results, a turn that calls an
 * operation, a write that waits for approval, spec paths beside the YAML, and
 * the schema; and the parser (lib/tools/openapi/parse.ts): the example specs'
 * declarations pinned, ADK's parse as the reference for its rules, and
 * hostile specs bounded. A real HTTP server on 127.0.0.1; scripted models.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionService, OpenAPIToolset, setLogLevel, LogLevel } from '@google/adk';

import { MAX_RESULT_CHARS, buildOpenApiTools, credentialEnvProblem, toSnake } from '../lib/tools/openapiTools.ts';
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
  // The built tools are ADK RestApiTools over the parse, so the declaration a model reads on the ADK path is the parser's.
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
  assert.throws(() => parseOpenApiDocument({ paths: { '/d': { post: { operationId: 'd', requestBody: { content: { 'application/json': { schema: deep } } } } } } }), /deeper than 128/);
  // A long chain of refs.
  // Listed from the far end, so resolving the first one walks the whole chain.
  const chain: Record<string, unknown> = {};
  for (let i = 500; i >= 1; i--) chain[`c${i}`] = { $ref: `#/c${i - 1}` };
  chain.c0 = { type: 'string' };
  assert.throws(() => parseOpenApiDocument({ ...chain, paths: { '/c': { get: { operationId: 'c', parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/c500' } }] } } } }), /deeper than 128/);
  // An external ref, and a document that is not one.
  assert.throws(() => parseOpenApiDocument({ paths: { '/e': { get: { operationId: 'e', parameters: [{ $ref: 'other.yaml#/p' }] } } } }), /external references are not supported/);
  assert.throws(() => parseOpenApiSpec('"just a string"', 'json'), /not an OpenAPI document/);
  assert.throws(() => parseOpenApiSpec('{', 'json', { source: 'bad.json' }), /openapi bad\.json: the spec is not valid JSON/);
});

test('a ref cycle ends where it closes, and a __proto__ key stays a key', () => {
  const [plant] = parseOpenApiSpec(SINK, 'yaml').filter((o) => o.path === '/trees');
  const child = (plant!.declaration.parameters as any).properties.child;
  // Node was resolved where components lists it, so its self-reference is already cut: an empty object.
  assert.deepEqual(child, { type: 'object', properties: { dummy_DO_NOT_GENERATE: { type: 'string' } } });
  const [op] = parseOpenApiSpec('{"paths":{"/p":{"post":{"operationId":"p","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"__proto__":{"type":"string","polluted":true}}}}}}}}}}', 'json');
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(op!.parameters.map((p) => p.name), ['proto']);
});
