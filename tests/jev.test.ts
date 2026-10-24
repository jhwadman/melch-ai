/**
 * tests/jev.test.ts — TypeSafe Jev (ADR 0144), offline.
 *
 * No network, no real keys: fetch is a stub, the env is set and restored
 * around each test. Covers the routing (a jev-* id to JevAdapter directly,
 * and on each gateway's System One route when TYPESAFE_API_KEY is absent),
 * the gateways' wire ids, the gateway settings read through the credential
 * source, the schema-to-questions mapping and its refusals, the state the
 * adapter sends, the answers-to-object mapping, and the failures as error
 * finals with the retry verdict. The capability matrix's typesafe row is
 * tests/capabilityMatrix.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { setCredentialSource } from '../lib/models/credentialSource.ts';
import { GATEWAYS, gatewayConfig, gatewaySystemOneModel, planTransport } from '../lib/models/gateway.ts';
import { JevAdapter, stateOf } from '../lib/models/jevAdapter.ts';
import { JevError, choice, decide, jevEndpointFromEnv, noul, objectFromAnswers, questionsFromSchema, score } from '../lib/models/jev.ts';
import type { JevAnswers } from '../lib/models/jev.ts';
import { resolveAdapter } from '../lib/models/adapterResolver.ts';
import { providerStatuses } from '../lib/models/registry.ts';
import { capabilityOf } from '../lib/models/capabilities.ts';
import type { FinalModelResponse, ModelRequest, ModelResponse } from '../lib/models/contract.ts';

process.env.OTEL_CONSOLE_SPANS = 'false';

const ENV_KEYS = ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'MODEL_GATEWAY', 'MODEL_GATEWAY_API_KEY', 'MODEL_GATEWAY_BASE_URL', 'MODEL_GATEWAY_MODEL_MAP', 'MODEL_RETRY_MAX_ATTEMPTS', 'ANTHROPIC_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY'];
const KEY = 'fixture-typesafe-0123456789abcdef'; // gitleaks:allow (test fixture)
const GW_KEY = 'fixture-gateway-0123456789abcdef'; // gitleaks:allow (test fixture)

/** Runs fn with ONLY the given env vars set (of the ones this suite touches). */
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

type Posted = { url: string; headers: Record<string, string>; body: any };

/** Runs fn with fetch answering `reply` to every request; returns what was posted. */
async function withFetch<T>(reply: (posted: Posted) => Response | Promise<Response>, fn: () => Promise<T>): Promise<{ posted: Posted[]; result: T }> {
  const original = globalThis.fetch;
  const posted: Posted[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const p: Posted = { url: String(input), headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: init?.body ? JSON.parse(init.body) : undefined };
    posted.push(p);
    return reply(p);
  }) as any;
  try {
    return { posted, result: await fn() };
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ANSWERS = {
  model: 'jev-1.14.0',
  answers: {
    department: { type: 'choice', choice: 'technical', confidence: 0.91, probabilities: { billing: 0.03, technical: 0.91, sales: 0.06 } },
    urgency: { type: 'score', score: 1.8, confidence: 0.8, legend: { '0': 'later', '1': 'today', '2': 'now' }, probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 } },
    needs_human: { type: 'noul', noul: 0.62 },
  },
  usage: { input_tokens: 240, output_tokens: 0 },
};

const SCHEMA = {
  type: 'object',
  properties: {
    department: { type: 'string', description: 'Which team.', enum: ['billing', 'technical', 'sales'] },
    urgency: { type: 'integer', description: 'How soon.', oneOf: [{ const: 0, description: 'later' }, { const: 1, description: 'today' }, { const: 2, description: 'now' }] },
    needs_human: { type: 'boolean', oneOf: [{ const: true, description: 'a person first' }, { const: false, description: 'routine' }] },
  },
};

async function collect(gen: AsyncIterable<ModelResponse>): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}
const finalOf = (rs: ModelResponse[]): FinalModelResponse => {
  const f = rs.at(-1);
  assert.ok(f && !f.partial, 'ends on a final');
  assert.equal(rs.length, 1, 'the final is the only response');
  return f;
};
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'jev-latest', messages: [{ role: 'user', parts: [{ type: 'text', text: 'My API returns 500s and orders are stuck.' }] }], outputSchema: SCHEMA, ...over });

// ── Routing ──────────────────────────────────────────────────────────────────

test('a jev-* id resolves to JevAdapter on TypeSafe\'s API when its key is set, and nothing else is funded by it', async () => {
  await withEnv({ TYPESAFE_API_KEY: KEY }, () => {
    const a = resolveAdapter('jev-latest');
    assert.ok(a instanceof JevAdapter);
    assert.equal(a.provider, 'typesafe');
    assert.equal(a.model, 'jev-latest');
    assert.equal(a.endpointUrl, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(a.transport(), 'direct');
    assert.deepEqual(planTransport('jev-1.14.0'), { provider: 'typesafe', transport: 'direct', funded: true, keyEnv: 'TYPESAFE_API_KEY' });
    const statuses = Object.fromEntries(providerStatuses().map((s) => [s.provider, s.available]));
    assert.equal(statuses.typesafe, true);
    assert.equal(statuses.anthropic, false, 'a TypeSafe key funds TypeSafe only');
  });
});

test('TYPESAFE_BASE_URL puts a proxy in front; the path stays /systemone', async () => {
  await withEnv({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'https://proxy.example.test/typesafe/v1/' }, () => {
    assert.equal(new JevAdapter({ model: 'jev-latest' }).endpointUrl, 'https://proxy.example.test/typesafe/v1/systemone');
  });
});

test('without a TypeSafe key, a configured gateway serves jev-* ids on its own System One route, with its own ids', async () => {
  await withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: GW_KEY }, () => {
    const plan = planTransport('jev-latest');
    assert.equal(plan.transport, 'gateway');
    assert.equal(plan.gateway?.id, 'vercel');
    const a = resolveAdapter('jev-latest');
    assert.ok(a instanceof JevAdapter, 'not the chat-completions gateway adapter');
    assert.equal(a.provider, 'typesafe', 'attribution stays with TypeSafe');
    assert.equal(a.endpointUrl, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    assert.equal(a.transport(), 'gateway:vercel');
    assert.equal(capabilityOf('jev-latest', 'structured_output').row, 'typesafe', 'the row is Jev\'s own, not the chat gateway\'s');
    const status = providerStatuses().find((s) => s.provider === 'typesafe')!;
    assert.deepEqual([status.available, status.transport, status.gateway], [true, 'gateway', 'vercel']);
  });
  await withEnv({ MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: GW_KEY }, () => {
    assert.equal((resolveAdapter('jev-1.14.0') as JevAdapter).endpointUrl, 'https://openrouter.ai/api/v1/systemone');
  });
  await withEnv({}, () => {
    assert.deepEqual(planTransport('jev-latest'), { provider: 'typesafe', transport: 'direct', funded: false, keyEnv: 'TYPESAFE_API_KEY' });
  });
});

test('each gateway\'s wire id for a jev-* id: Vercel\'s documented typesafe-ai/jev for the aliases, OpenRouter drops the patch; MODEL_GATEWAY_MODEL_MAP wins', async () => {
  await withEnv({}, () => {
    assert.equal(gatewaySystemOneModel('jev-latest', GATEWAYS.vercel), 'typesafe-ai/jev');
    assert.equal(gatewaySystemOneModel('jev-preview', GATEWAYS.vercel), 'typesafe-ai/jev');
    assert.equal(gatewaySystemOneModel('jev-1.14.0', GATEWAYS.vercel), 'jev-1.14.0', 'as GET /typesafe/v1/models lists it');
    assert.equal(gatewaySystemOneModel('jev-latest', GATEWAYS.openrouter), '~typesafe/jev-latest');
    assert.equal(gatewaySystemOneModel('jev-1.14.0', GATEWAYS.openrouter), 'typesafe/jev-1.14');
    assert.equal(gatewaySystemOneModel('jev-1.13.0', GATEWAYS.openrouter), 'typesafe/jev-1.13');
  });
  await withEnv({ MODEL_GATEWAY_MODEL_MAP: 'jev-latest=typesafe/jev-9' }, () => {
    assert.equal(gatewaySystemOneModel('jev-latest', GATEWAYS.openrouter), 'typesafe/jev-9');
  });
});

test('the gateway kind and key are read through the credential source, so a host\'s keychain can set them (ADR 0133)', async () => {
  await withEnv({}, () => {
    const held: Record<string, string> = { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: GW_KEY };
    setCredentialSource((name) => held[name]);
    try {
      assert.equal(gatewayConfig()?.gateway.id, 'openrouter');
      assert.equal(gatewayConfig()?.keyPresent, true);
      assert.equal(planTransport('claude-sonnet-4-6').transport, 'gateway');
      assert.equal(jevEndpointFromEnv().transport, 'gateway:openrouter');
      delete held.MODEL_GATEWAY;
      assert.equal(gatewayConfig(), null, 'nothing is cached');
    } finally {
      setCredentialSource(undefined);
    }
  });
});

// ── The schema as questions ──────────────────────────────────────────────────

test('questionsFromSchema: a boolean is a noul, an enum or described oneOf is a choice, levelled integers are a score; the description is the instruction', () => {
  assert.deepEqual(questionsFromSchema(SCHEMA), {
    department: { type: 'choice', instructions: 'Which team.', criteria: { billing: 'billing', technical: 'technical', sales: 'sales' } },
    urgency: { type: 'score', instructions: 'How soon.', criteria: ['later', 'today', 'now'] },
    needs_human: { type: 'noul', instructions: 'needs human', criteria: { true: 'a person first', false: 'routine' } },
  });
});

test('questionsFromSchema refuses what Jev cannot decide, naming the property and the shapes it takes', () => {
  const refuses = (schema: unknown, code: string, re: RegExp) => {
    try {
      questionsFromSchema(schema);
      assert.fail('should refuse');
    } catch (err) {
      assert.ok(err instanceof JevError, String(err));
      assert.equal(err.code, code);
      assert.match(err.message, re);
    }
  };
  refuses(undefined, 'TYPESAFE_SCHEMA_REQUIRED', /output\.schema/);
  refuses({ type: 'object', properties: {} }, 'TYPESAFE_SCHEMA_REQUIRED', /at least one/);
  refuses({ type: 'object', properties: { summary: { type: 'string' } } }, 'TYPESAFE_SCHEMA_UNSUPPORTED', /"summary".*enum/);
  refuses({ type: 'object', properties: { n: { type: 'integer' } } }, 'TYPESAFE_SCHEMA_UNSUPPORTED', /"n".*levels 0\.\.n-1/);
  refuses({ type: 'object', properties: { n: { type: 'integer', oneOf: [{ const: 1, description: 'one' }] } } }, 'TYPESAFE_SCHEMA_UNSUPPORTED', /level 0 is 1/);
  refuses({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }, 'TYPESAFE_SCHEMA_UNSUPPORTED', /"tags"/);
  refuses({ type: 'object', properties: { jev: { type: 'boolean' } } }, 'TYPESAFE_SCHEMA_UNSUPPORTED', /reserved/);
});

test('objectFromAnswers: the schema\'s values, and the raw answers under jev', () => {
  const object = objectFromAnswers(questionsFromSchema(SCHEMA), ANSWERS.answers as any);
  assert.deepEqual(object, { department: 'technical', urgency: 2, needs_human: true, jev: ANSWERS.answers });
  // The most probable level, not the rounded mean, and no at 0.49.
  const other = objectFromAnswers(questionsFromSchema(SCHEMA), {
    ...ANSWERS.answers,
    urgency: { ...ANSWERS.answers.urgency, score: 1.6, probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 } },
    needs_human: { type: 'noul', noul: 0.49 },
  } as any);
  assert.deepEqual([other.urgency, other.needs_human], [1, false]);
});

// ── The call ─────────────────────────────────────────────────────────────────

test('decide() posts state and questions with the bearer, reads the typed answers, and types them on the questions', async () => {
  await withEnv({ TYPESAFE_API_KEY: KEY }, async () => {
    const { posted, result } = await withFetch(
      () => json(ANSWERS),
      () =>
        decide({
          model: 'jev-latest',
          state: 'My API returns 500s.',
          questions: {
            department: choice('Which team', { billing: 'money', technical: 'bugs', sales: 'pricing' }),
            urgency: score('How soon', ['later', 'today', 'now']),
            needs_human: noul('A person first'),
          },
        }),
    );
    assert.equal(posted[0]!.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(posted[0]!.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(posted[0]!.body, {
      model: 'jev-latest',
      state: 'My API returns 500s.',
      questions: {
        department: { type: 'choice', instructions: 'Which team', criteria: { billing: 'money', technical: 'bugs', sales: 'pricing' } },
        urgency: { type: 'score', instructions: 'How soon', criteria: ['later', 'today', 'now'] },
        needs_human: { type: 'noul', instructions: 'A person first' },
      },
    });
    // Typed on the criteria: `choice` is the union of the keys given.
    const dept: 'billing' | 'technical' | 'sales' = result.answers.department.choice;
    assert.equal(dept, 'technical');
    assert.equal(result.answers.needs_human.noul, 0.62);
    assert.equal(result.answers.urgency.probabilities['2'], 0.85);
    assert.deepEqual(result.usage, { input_tokens: 240, output_tokens: 0 });
    // The answers type is the questions' shape.
    const _check: JevAnswers<{ x: ReturnType<typeof noul> }> = { x: { type: 'noul', noul: 1 } };
    void _check;
  });
});

test('decide() without a key is TYPESAFE_MISSING_KEY, before any request; with a gateway it goes there with the gateway\'s bearer', async () => {
  await withEnv({}, async () => {
    const { posted } = await withFetch(
      () => json(ANSWERS),
      () => decide({ model: 'jev-latest', state: 'x', questions: { ok: noul('ok?') } }).then(() => assert.fail('should throw'), (err) => assert.equal((err as JevError).code, 'TYPESAFE_MISSING_KEY')),
    );
    assert.equal(posted.length, 0);
  });
  await withEnv({ MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: GW_KEY }, async () => {
    const { posted, result } = await withFetch(
      () => json({ model: 'typesafe/jev-1.14', answers: { ok: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 9, output_tokens: 0 } }),
      () => decide({ model: 'jev-1.14.0', state: 'x', questions: { ok: noul('ok?') } }),
    );
    assert.equal(result.answers.ok.noul, 0.97);
    assert.equal(posted[0]!.url, 'https://openrouter.ai/api/v1/systemone');
    assert.equal(posted[0]!.headers.Authorization, `Bearer ${GW_KEY}`);
    assert.equal(posted[0]!.body.model, 'typesafe/jev-1.14');
  });
});

test('JevAdapter: the instruction then the conversation as state, the schema as questions, the object as the final\'s text, the usage counted', async () => {
  await withEnv({ TYPESAFE_API_KEY: KEY }, async () => {
    const req = request({
      system: 'You triage support messages.',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Earlier I asked about pricing.' }] },
        { role: 'assistant', parts: [{ type: 'text', text: '{"department":"sales"}' }] },
        { role: 'user', parts: [{ type: 'text', text: 'Now my API returns 500s.' }, { type: 'blob', mimeType: 'image/png', data: 'aGk=' }] },
      ],
    });
    assert.deepEqual(stateOf(req), ['You triage support messages.', 'Earlier I asked about pricing.', 'Earlier answer: {"department":"sales"}', 'Now my API returns 500s.']);
    const { posted, result } = await withFetch(() => json(ANSWERS), () => collect(new JevAdapter({ model: 'jev-latest' }).generate(req)));
    assert.equal(posted[0]!.body.model, 'jev-latest');
    assert.ok(!JSON.stringify(posted[0]!.body).includes('aGk='), 'images are dropped');
    const final = finalOf(result);
    assert.equal(final.finishReason, 'stop');
    assert.equal(final.error, undefined);
    assert.deepEqual(JSON.parse((final.parts[0] as any).text), { department: 'technical', urgency: 2, needs_human: true, jev: ANSWERS.answers });
    assert.deepEqual(final.usage, { inputTokens: 240, outputTokens: 0 });
    // One user message and no instruction: the state is that one string.
    assert.equal(stateOf(request()), 'My API returns 500s and orders are stuck.');
  });
});

test('JevAdapter failures are error finals, never throws: a 422 is final, a 503 is retryable, an unreachable endpoint is retryable, a cancelled call is not', async () => {
  await withEnv({ TYPESAFE_API_KEY: KEY, MODEL_RETRY_MAX_ATTEMPTS: '1' }, async () => {
    const adapter = new JevAdapter({ model: 'jev-latest' });
    const bad = finalOf((await withFetch(() => json({ detail: [{ loc: ['questions'], msg: 'bad', type: 'value_error' }] }, 422), () => collect(adapter.generate(request())))).result);
    assert.equal(bad.error?.code, 'TYPESAFE_HTTP_ERROR');
    assert.deepEqual([bad.error?.retryable, bad.error?.status, bad.finishReason], [false, 422, 'error']);
    assert.match(bad.error!.message, /TypeSafe returned 422 for jev-latest/);
    assert.ok(!bad.error!.message.includes(KEY), 'never the key');

    const busy = finalOf((await withFetch(() => json({ error: 'busy' }, 503), () => collect(adapter.generate(request())))).result);
    assert.deepEqual([busy.error?.code, busy.error?.retryable, busy.error?.status], ['TYPESAFE_HTTP_ERROR', true, 503]);

    const down = finalOf((await withFetch(() => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), () => collect(adapter.generate(request())))).result);
    assert.deepEqual([down.error?.code, down.error?.retryable], ['TYPESAFE_UNREACHABLE', true]);
    assert.match(down.error!.message, /Could not reach TypeSafe at https:\/\/api\.typesafe\.ai\/v1\/systemone/);

    const controller = new AbortController();
    controller.abort();
    const cancelled = finalOf((await withFetch(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), () => collect(adapter.generate(request({ signal: controller.signal }))))).result);
    assert.equal(cancelled.error?.retryable, false, 'no fallback answers a cancellation');

    const garbled = finalOf((await withFetch(() => json({ model: 'jev', answers: { department: { type: 'noul', noul: 1 } } }), () => collect(adapter.generate(request())))).result);
    assert.equal(garbled.error?.code, 'TYPESAFE_BAD_ANSWER');
    assert.match(garbled.error!.message, /choice decision for "department"/);
  });
});

test('through a gateway, a 404 names MODEL_GATEWAY_MODEL_MAP as the fix', async () => {
  await withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: GW_KEY, MODEL_RETRY_MAX_ATTEMPTS: '1' }, async () => {
    const adapter = resolveAdapter('jev-latest') as JevAdapter;
    const { posted, result } = await withFetch(() => json({ error: 'no such model' }, 404), () => collect(adapter.generate(request())));
    assert.equal(posted[0]!.body.model, 'typesafe-ai/jev');
    assert.equal(posted[0]!.headers.Authorization, `Bearer ${GW_KEY}`);
    const final = finalOf(result);
    assert.match(final.error!.message, /Vercel AI Gateway returned 404 for typesafe-ai\/jev/);
    assert.match(final.error!.message, /MODEL_GATEWAY_MODEL_MAP=jev-latest=/);
    assert.match(final.error!.message, /\/typesafe\/v1\/models/);
  });
});

// ── The shipped classifier, through the turn runner ─────────────────────────

test('examples/classifier.yaml runs one turn on the native loop: the schema reaches Jev as questions, and the reply is the object', async () => {
  const { loadSyndicate } = await import('../lib/loadSyndicate.ts');
  const { runSyndicateTurn } = await import('../lib/runtime/syndicateTurn.ts');
  const { InProcessSessionService } = await import('../lib/runtime/sessions.ts');
  const config = loadSyndicate('examples/classifier.yaml');
  assert.equal(config.orchestrator.model, 'jev-latest');
  await withEnv({ TYPESAFE_API_KEY: KEY }, async () => {
    const { posted, result } = await withFetch(
      () => json(ANSWERS),
      () =>
        runSyndicateTurn({
          config,
          parts: [{ text: 'Our API integration returns 500s on every request and we cannot process orders.' }],
          appName: 'jev-test',
          userId: 'u1',
          sessionId: 's1',
          sessionService: new InProcessSessionService(),
          trace: false,
        }),
    );
    assert.equal(posted.length, 1, 'one System One call, no tool loop');
    const body = posted[0]!.body;
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(Object.keys(body.questions), ['department', 'urgency', 'needs_human']);
    assert.equal(body.questions.department.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.department.criteria), ['billing', 'technical', 'sales', 'other']);
    assert.equal(body.questions.urgency.type, 'score');
    assert.equal(body.questions.urgency.criteria.length, 3);
    assert.equal(body.questions.needs_human.type, 'noul');
    assert.ok(Array.isArray(body.state) && body.state[0].startsWith('You triage inbound messages'), 'the instruction leads the state');
    assert.ok(body.state.at(-1).includes('500s'), 'the message ends it');
    assert.equal(result.status, 'completed', JSON.stringify(result.error ?? null));
    const reply = JSON.parse(result.text ?? '');
    assert.deepEqual([reply.department, reply.urgency, reply.needs_human], ['technical', 2, true]);
    assert.equal(reply.jev.department.confidence, 0.91);
  });
});
