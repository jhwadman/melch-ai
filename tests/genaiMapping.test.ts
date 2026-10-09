/**
 * tests/genaiMapping.test.ts — genai Content, the genai-shaped LlmRequest and
 * LlmResponse, to and from the engine's model contract
 * (lib/models/genaiMapping.ts, ADR 0048).
 *
 * Asserted:
 *   - Every event content of every stored session fixture, trimmed and
 *     verbatim, round-trips Content → contract → Content to the same JSON
 *     (keys compared sorted: jsonb keeps no key order), one content at a time
 *     and as a whole history; and the history read the way an LlmRequest
 *     carries it (ADK's `adk-` ids stripped) round-trips too.
 *   - A thoughtSignature, a call id and another adapter's providerState
 *     survive, and so do the parts the contract cannot hold exactly.
 *   - The LlmRequest a native turn's ModelRequest maps to reads back as a
 *     ModelRequest with the agent's tools and system text.
 *   - A ModelResponse maps to the LlmResponse ADK expected.
 *   - The reverse directions: a ModelRequest round-trips through an
 *     LlmRequest; every fixture history, and the request a native turn
 *     sent, round-trips the other
 *     way; every model event of every fixture round-trips through a
 *     ModelResponse, thinking aside; a ModelResponse round-trips through an
 *     LlmResponse.
 *
 * Offline: scripted models, in-memory sessions, no provider calls.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Content } from '@google/genai';

import {
  GEMINI_PROVIDER,
  GENAI_PART_KIND,
  MINTED_CALL_ID_PREFIX,
  THOUGHT_SIGNATURE_KIND,
  contentToMessage,
  contentsToMessages,
  llmRequestToModelRequest,
  llmResponseToModelResponse,
  messageToContent,
  messagesToContents,
  modelRequestToLlmRequest,
  modelResponseToLlmResponse,
  nativeToolsWithoutGeminiTool,
  reasoningOf,
  systemText,
  usageFromMetadata,
  usageToMetadata,
} from '../lib/models/genaiMapping.ts';
import type { LlmRequest, LlmResponse } from '../lib/models/genaiMapping.ts';
import type { FinalModelResponse, Message, ModelRequest, ModelResponse, Part, ToolCallPart, ToolResultPart } from '../lib/models/contract.ts';
import { ERROR_RETRYABLE_KEY, ERROR_STATUS_KEY, withRetryVerdict } from '../lib/models/errorResponse.ts';
import { contractToolDeclaration } from '../lib/models/schemaNormalize.ts';
import type { ProviderState } from '../lib/models/providerState.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { SKIP_SIGNATURE } from '../lib/session/transcript.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { COLLECTIONS_SEARCH_MARKER, WEB_SEARCH_MARKER, X_SEARCH_MARKER } from '../lib/tools/nativeTools.ts';
import { THOUGHT_SIGNATURE } from './fixtures/sessions/scenarios.ts';
import { fixtureFiles, loadFixture } from './helpers/sessionFixtures.ts';
import type { SessionFixture } from './helpers/sessionFixtures.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';

/** JSON with every object's keys sorted: the bytes a jsonb column gives back, whatever the key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

function assertRoundTrip(content: Content, label: string, index = 0): Message {
  const message = contentToMessage(content, index);
  const back = messageToContent(message);
  assert.equal(canonical(back), canonical(content), `${label}: the content comes back byte-equal`);
  assert.deepEqual(back, content, `${label}: and with no key it did not have`);
  assert.deepEqual(contentToMessage(back, index), message, `${label}: the message it maps to is stable`);
  return message;
}

function allFixtures(): Array<{ name: string; fixture: SessionFixture; contents: Content[][] }> {
  return fixtureFiles().map((name) => {
    const [base, form] = name.endsWith('.verbatim') ? [name.replace(/\.verbatim$/, ''), 'verbatim' as const] : [name, 'trimmed' as const];
    const fixture = loadFixture(base, form);
    return { name, fixture, contents: fixture.sessions.map((row) => row.events.flatMap((e) => (e.content ? [e.content as Content] : []))) };
  });
}

/** The contents as an LlmRequest carries them: ADK strips its own `adk-` call ids (removeClientFunctionCallId). */
function asRequestContents(contents: Content[]): Content[] {
  const copy = structuredClone(contents) as Content[];
  for (const content of copy) {
    for (const part of content.parts ?? []) {
      if (part.functionCall?.id?.startsWith('adk-')) part.functionCall.id = undefined;
      if (part.functionResponse?.id?.startsWith('adk-')) part.functionResponse.id = undefined;
    }
  }
  return copy;
}

const partsOf = (messages: Message[]): Part[] => messages.flatMap((m) => m.parts as Part[]);
const gemini = (kind: string, payload: unknown): ProviderState => ({ provider: GEMINI_PROVIDER, kind, payload });

// ── Stored sessions round-trip ───────────────────────────────────────────────

test('every event content of every session fixture round-trips Content → contract → Content byte-equal', () => {
  const fixtures = allFixtures();
  assert.ok(fixtures.some((f) => f.name.endsWith('.verbatim')) && fixtures.some((f) => !f.name.endsWith('.verbatim')), 'both stored forms are covered');
  let count = 0;
  for (const { name, contents: rows } of fixtures) {
    let inFile = 0;
    for (const contents of rows) {
      contents.forEach((content, i) => {
        assertRoundTrip(content, `${name} content ${i}`, i);
        // ADK wrote the fixtures' parts' keys in the order the mapping writes them.
        assert.equal(JSON.stringify(messageToContent(contentToMessage(content, i)).parts), JSON.stringify(content.parts), `${name} content ${i}: parts in ADK's key order`);
        inFile++;
      });
      // The whole history: ids pair across contents, and the inverse gives it all back.
      const history = contentsToMessages(contents);
      const back = messagesToContents(history);
      assert.equal(canonical(back.contents), canonical(contents), `${name}: the history comes back byte-equal`);
      assert.equal(back.systemInstruction, undefined);
      assert.deepEqual(contentsToMessages(back.contents).messages, history.messages, `${name}: contract → Content → contract is stable`);
    }
    assert.ok(inFile > 0, `${name}: no event content`);
    count += inFile;
  }
  assert.ok(count >= 30, `only ${count} contents were checked`);
});

test('the fixtures as an LlmRequest carries them (adk- ids stripped) round-trip too, with minted ids pairing each call and result', () => {
  let paired = 0;
  for (const { name, contents: rows } of allFixtures()) {
    for (const stored of rows) {
      const contents = asRequestContents(stored);
      const { messages } = contentsToMessages(contents);
      assert.equal(canonical(messagesToContents({ messages }).contents), canonical(contents), `${name}: the absence of an id is restored`);
      const calls = partsOf(messages).filter((p): p is ToolCallPart => p.type === 'toolCall');
      const results = partsOf(messages).filter((p): p is ToolResultPart => p.type === 'toolResult');
      for (const p of [...calls, ...results]) assert.ok(p.id, `${name}: ${p.type} ${p.name} has an id`);
      // A stripped call is answered by the stripped result that answered it in storage.
      const storedParts = stored.flatMap((c) => c.parts ?? []);
      for (const result of results.filter((r) => r.id.startsWith(MINTED_CALL_ID_PREFIX))) {
        const storedResult = storedParts.find((p) => p.functionResponse?.name === result.name)!.functionResponse!;
        const storedCall = storedParts.find((p) => p.functionCall?.id === storedResult.id);
        if (!storedCall) continue; // the call was in another row (a subagent's own session)
        const call = calls.find((c) => c.name === storedCall.functionCall!.name);
        assert.equal(result.id, call?.id, `${name}: ${result.name}'s result answers its call`);
        paired++;
      }
    }
  }
  assert.ok(paired >= 4, `only ${paired} stripped calls were paired`);
});

test('ids: a stored adk- call id passes through and pairs its result; nothing is minted', () => {
  const { messages } = contentsToMessages(allFixtures().find((f) => f.name === '01-delegate')!.contents[0]);
  const call = partsOf(messages).find((p): p is ToolCallPart => p.type === 'toolCall')!;
  const result = partsOf(messages).find((p): p is ToolResultPart => p.type === 'toolResult')!;
  assert.match(call.id, /^adk-/);
  assert.equal(result.id, call.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(call.args, { request: 'look in the attic' });
  assert.deepEqual(result.result, 'it is in the attic');
});

test('ids: parallel calls to one tool without ids pair with their results in order; a lone content mints but does not pair', () => {
  const contents: Content[] = [
    { role: 'user', parts: [{ text: 'two quotes' }] },
    { role: 'model', parts: [{ functionCall: { name: 'quote', args: { t: 'MU' } } }, { functionCall: { name: 'quote', args: { t: 'NVDA' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'quote', response: { p: 1 } } }, { functionResponse: { name: 'quote', response: { p: 2 } } }] },
  ];
  const { messages } = contentsToMessages(contents);
  const [a, b] = messages[1].parts as ToolCallPart[];
  const [ra, rb] = messages[2].parts as ToolResultPart[];
  assert.equal(a.id, `${MINTED_CALL_ID_PREFIX}1-0`);
  assert.equal(b.id, `${MINTED_CALL_ID_PREFIX}1-1`);
  assert.deepEqual([ra.id, rb.id], [a.id, b.id]);
  assert.equal(canonical(messagesToContents({ messages }).contents), canonical(contents));

  const lone = contentToMessage(contents[2], 2);
  assert.deepEqual((lone.parts as ToolResultPart[]).map((p) => p.id), [`${MINTED_CALL_ID_PREFIX}2-0`, `${MINTED_CALL_ID_PREFIX}2-1`]);
});

test('ids: a result without an id answers the latest open call of its name, and an unanswered one gets its own', () => {
  const { messages } = contentsToMessages([
    { role: 'model', parts: [{ functionCall: { name: 'look', args: {} } }] },
    { role: 'model', parts: [{ functionCall: { name: 'look', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'look', response: {} } }, { functionResponse: { name: 'other', response: {} } }] },
  ]);
  const [result, orphan] = messages[2].parts as ToolResultPart[];
  assert.equal(result.id, (messages[1].parts[0] as ToolCallPart).id);
  assert.equal(orphan.id, `${MINTED_CALL_ID_PREFIX}2-1`);
});

// ── What survives ────────────────────────────────────────────────────────────

test('thoughtSignature: a Gemini signature becomes providerState on the same part, and back', () => {
  const verbatim = contentsToMessages(allFixtures().find((f) => f.name === '06-thought-signature.verbatim')!.contents[0]).messages;
  const turn = verbatim[1].parts as Part[];
  assert.equal(turn[0].type, 'thinking');
  assert.match((turn[0] as { text: string }).text, /Checking the quote/);
  assert.equal(turn[1].type, 'toolCall');
  assert.deepEqual(turn[1].providerState, gemini(THOUGHT_SIGNATURE_KIND, THOUGHT_SIGNATURE));
  const answer = verbatim.at(-1)!.parts[0] as Part;
  assert.equal(answer.type, 'text');
  assert.deepEqual(answer.providerState, gemini(THOUGHT_SIGNATURE_KIND, THOUGHT_SIGNATURE));

  const trimmed = contentsToMessages(allFixtures().find((f) => f.name === '06-thought-signature')!.contents[0]).messages;
  assert.deepEqual((trimmed[1].parts[1] as Part).providerState, gemini(THOUGHT_SIGNATURE_KIND, SKIP_SIGNATURE));

  const back = messageToContent({ role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'f', args: {}, providerState: gemini(THOUGHT_SIGNATURE_KIND, 'sig') }] });
  assert.deepEqual(back, { role: 'model', parts: [{ functionCall: { name: 'f', args: {}, id: 'c1' }, thoughtSignature: 'sig' }] });
});

test("providerState: another adapter's state passes through on every part kind", () => {
  const state: ProviderState = { provider: 'anthropic', kind: 'thinking_blocks', model: 'claude-opus-4-6', payload: [{ type: 'thinking', thinking: 'x', signature: 's' }] };
  const content: Content = {
    role: 'model',
    parts: [
      { text: 'Let me check.', providerState: state },
      { functionCall: { name: 'look', args: { q: 1 }, id: 'toolu_1' }, providerState: state },
      { text: 'thinking', thought: true, providerState: state },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' }, providerState: state },
    ] as unknown as Content['parts'],
  };
  const message = assertRoundTrip(content, 'anthropic state');
  for (const part of message.parts as Part[]) assert.deepEqual(part.providerState, state, `${part.type} keeps the state`);
  const results = assertRoundTrip({ role: 'user', parts: [{ functionResponse: { id: 'toolu_1', name: 'look', response: { ok: true } }, providerState: state }] as unknown as Content['parts'] }, 'state on a result');
  assert.equal(results.role, 'tool');
  assert.deepEqual((results.parts[0] as Part).providerState, state);
});

test('code execution: executableCode and codeExecutionResult read as text and come back whole, signature included', () => {
  const content: Content = {
    role: 'model',
    parts: [
      { executableCode: { language: 'PYTHON' as never, code: 'print(6 * 7)' }, thoughtSignature: 'c2ln' },
      { codeExecutionResult: { outcome: 'OUTCOME_OK' as never, output: '42\n' } },
      { codeExecutionResult: { outcome: 'OUTCOME_FAILED' as never, output: 'Traceback' } },
      { text: 'It is 42.' },
    ],
  };
  const message = assertRoundTrip(content, 'code execution');
  const [code, output, failed, answer] = message.parts as Part[];
  assert.deepEqual(code, { type: 'text', text: '```python\nprint(6 * 7)\n```', providerState: gemini(GENAI_PART_KIND, content.parts![0]) });
  assert.deepEqual(output, { type: 'text', text: 'Output:\n42\n', providerState: gemini(GENAI_PART_KIND, content.parts![1]) });
  assert.equal((failed as { text: string }).text, 'Output (OUTCOME_FAILED):\nTraceback');
  assert.deepEqual(answer, { type: 'text', text: 'It is 42.' });
});

test('every part the contract cannot hold exactly, or its message cannot hold, is carried whole', () => {
  const odd: Array<[string, Content]> = [
    ['an ADK confirmation request (a call in a user content)', {
      parts: [{ functionCall: { name: 'adk_request_confirmation', args: { originalFunctionCall: { name: 'send', args: {}, id: 'adk-1' } }, id: 'adk-2' } }],
      role: 'user',
    }],
    ['a thought in a user content', { role: 'user', parts: [{ text: 'hmm', thought: true }] }],
    ['thought: false', { role: 'model', parts: [{ text: 'x', thought: false }] }],
    ['a blob with a display name', { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA', displayName: 'chart.png' } }] }],
    ['a file by URL', { role: 'user', parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'https://example.test/a.pdf' } }] }],
    ['a call with no args', { role: 'model', parts: [{ functionCall: { name: 'now', id: 'c1' } }] }],
    ['a call with a field the contract lacks', { role: 'model', parts: [{ functionCall: { name: 'now', args: {}, id: 'c1', willContinue: false } }] }],
    ['a result in a model content', { role: 'model', parts: [{ functionCall: { name: 'f', args: {}, id: 'c1' } }, { functionResponse: { name: 'f', id: 'c1', response: { r: 1 } } }] }],
    ['a result with text beside it', { role: 'user', parts: [{ text: 'and also' }, { functionResponse: { name: 'f', id: 'c1', response: { r: 1 } } }] }],
    ['a signature beside another state', { role: 'model', parts: [{ text: 'x', thoughtSignature: 'sig', providerState: { provider: 'openai', kind: 'reasoning_items', payload: [] } }] as unknown as Content['parts'] }],
    ['a stored state of the mapping\'s own kind', { role: 'model', parts: [{ text: 'x', providerState: gemini(THOUGHT_SIGNATURE_KIND, 'sig') }] as unknown as Content['parts'] }],
    ['a signature-only part', { role: 'model', parts: [{ text: 'done' }, { thoughtSignature: 'sig' }] }],
    ['an empty text with a signature', { role: 'model', parts: [{ text: '', thoughtSignature: 'sig' }] }],
    ['an unknown part', { role: 'model', parts: [{ videoMetadata: { fps: 1 } }] }],
    ['a system content', { role: 'system', parts: [{ text: 'Be brief.' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }],
    ['a result whose response is not an object', { role: 'user', parts: [{ functionResponse: { name: 'f', id: 'c1', response: 'bare' as never } }] }],
    ['an id of the minted shape', { role: 'model', parts: [{ functionCall: { name: 'f', args: {}, id: `${MINTED_CALL_ID_PREFIX}9-9` } }] }],
    ['no parts at all', { role: 'model', parts: [] }],
  ];
  for (const [label, content] of odd) {
    const message = assertRoundTrip(content, label);
    const allowed = { system: ['text'], user: ['text', 'blob'], assistant: ['text', 'thinking', 'toolCall', 'blob'], tool: ['toolResult'] }[message.role];
    for (const part of message.parts as Part[]) assert.ok(allowed.includes(part.type), `${label}: a ${part.type} part in a ${message.role} message`);
  }
  // The confirmation request stays a user message; its call is described, and carried whole.
  const confirmation = contentToMessage(odd[0][1]);
  assert.equal(confirmation.role, 'user');
  assert.match((confirmation.parts[0] as { text: string }).text, /^\[adk_request_confirmation called with /);
  assert.equal((confirmation.parts[0] as Part).providerState?.kind, GENAI_PART_KIND);
});

test('tool results: { error } is a failed tool, { result } a bare value, any other object the result itself', () => {
  const read = (response: Record<string, unknown>) => contentToMessage({ role: 'user', parts: [{ functionResponse: { id: 'c', name: 'f', response } }] }).parts[0] as ToolResultPart;
  assert.deepEqual(read({ error: 'boom' }), { type: 'toolResult', id: 'c', name: 'f', result: 'boom', isError: true });
  assert.deepEqual(read({ result: 'text' }), { type: 'toolResult', id: 'c', name: 'f', result: 'text' });
  assert.deepEqual(read({ result: { a: 1 } }), { type: 'toolResult', id: 'c', name: 'f', result: { result: { a: 1 } } });
  assert.deepEqual(read({ a: 1 }), { type: 'toolResult', id: 'c', name: 'f', result: { a: 1 } });
  assert.equal(read({ error: null }).isError, undefined, 'a null error is not a failure');
  assert.equal(read({ error: 'x', detail: 1 }).isError, undefined, 'only a response of exactly { error } is');

  const write = (result: unknown, isError?: boolean) =>
    messageToContent({ role: 'tool', parts: [{ type: 'toolResult', id: 'c', name: 'f', result, ...(isError ? { isError } : {}) }] }).parts![0].functionResponse!.response;
  assert.deepEqual(write('boom', true), { error: 'boom' });
  assert.deepEqual(write('text'), { result: 'text' });
  assert.deepEqual(write([1, 2]), { result: [1, 2] });
  assert.deepEqual(write({ a: 1 }), { a: 1 });
});

test('system instruction: every genai spelling reads as text, and the inverse gives it back as a string', () => {
  assert.equal(systemText('Be brief.'), 'Be brief.');
  assert.equal(systemText({ role: 'system', parts: [{ text: 'One.' }, { text: 'Two.' }] }), 'One.\nTwo.');
  assert.equal(systemText([{ text: 'One.' }, 'Two.']), 'One.\nTwo.');
  assert.equal(systemText({ text: 'Part.' }), 'Part.');
  assert.equal(systemText(undefined), undefined);
  assert.equal(systemText(''), undefined, 'an empty instruction is none, on every entry point');
  assert.deepEqual(contentsToMessages([], ''), { messages: [] });
  assert.equal('system' in llmRequestToModelRequest(bareRequest({ config: { systemInstruction: '' } })), false);
  const history = contentsToMessages([{ role: 'user', parts: [{ text: 'hi' }] }], 'Be brief.');
  assert.equal(history.system, 'Be brief.');
  assert.deepEqual(messagesToContents(history), { systemInstruction: 'Be brief.', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
});

// ── LlmRequest → ModelRequest ────────────────────────────────────────────────

const APP = 'genai-mapping';
const USER = 'u1';

function delegateConfig(tools: string[], model = 'scripted/boss'): SyndicateYamlConfig {
  return {
    syndicate_name: 'Mapping',
    orchestrator: { name: 'Boss', model, instruction: 'Delegate to Scout.', tools, reasoning: 'high' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
  } as SyndicateYamlConfig;
}

/** Runs one delegating turn and returns the second request Boss's script read, as an LlmRequest. */
async function secondRequest(boss: ScriptedLlm, config: SyndicateYamlConfig): Promise<LlmRequest> {
  const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
  const result = await runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: scriptedResolver({ boss, scout, claude: boss }) },
    trace: false,
  });
  assert.equal(result.status, 'completed');
  assert.equal(boss.requests.length, 2);
  return boss.requests[1];
}

const delegating = (model: string) =>
  new ScriptedLlm(model, (_req, n) =>
    n === 1 ? ({ content: { role: 'model', parts: [{ functionCall: { name: 'Scout', args: { request: 'look in the attic' } } }] } } as LlmResponse) : text('Scout says: the attic'),
  );

test('the LlmRequest a native turn sent maps to a ModelRequest with its tools and system text', async () => {
  const boss = delegating('scripted/boss');
  const request = await secondRequest(boss, delegateConfig(['load_memory', 'web_search']));
  const mapped = llmRequestToModelRequest(request, { stream: false });

  assert.equal(mapped.model, 'scripted/boss');
  assert.equal(mapped.system, request.config!.systemInstruction);
  assert.match(mapped.system!, /Delegate to Scout\./);

  // Every declared tool in toolsDict, and nothing else: the subagent, load_memory, and
  // the self-correction plugin's adk_handle_model_error (ADR 0034).
  const tools = new Map((mapped.tools ?? []).map((t) => [t.name, t]));
  assert.deepEqual([...tools.keys()].sort(), Object.keys(request.toolsDict).sort());
  assert.ok(tools.has('Scout') && tools.has('load_memory'));
  const scout = tools.get('Scout')!;
  assert.equal(scout.description, 'Finds things');
  assert.equal((scout.parameters as any).type, 'object', 'lowercase JSON Schema');
  assert.equal((scout.parameters as any).properties.request.type, 'string');
  assert.deepEqual((scout.parameters as any).required, ['request']);
  assert.ok((tools.get('load_memory')!.parameters as any).properties.query, 'load_memory keeps its query argument');
  assert.deepEqual(mapped.nativeTools, ['web_search'], "Gemini's googleSearch object reads as web_search");
  assert.equal(mapped.reasoning, 'high', 'reasoning: high compiled to thinkingLevel HIGH reads back as high');
  assert.equal(mapped.stream, false);

  // The history: the call and the result carry no id in the LlmRequest; minted ids pair them.
  assert.deepEqual(mapped.messages.map((m) => m.role), ['user', 'assistant', 'tool']);
  const call = mapped.messages[1].parts[0] as ToolCallPart;
  const result = mapped.messages[2].parts[0] as ToolResultPart;
  assert.equal(call.name, 'Scout');
  assert.ok(call.id.startsWith(MINTED_CALL_ID_PREFIX));
  assert.equal(result.id, call.id);
  assert.equal(result.result, 'it is in the attic');
  assert.equal(canonical(messagesToContents({ messages: mapped.messages }).contents), canonical(request.contents), 'the request contents round-trip');
});

test('on a model that is not Gemini, the web_search sentinel reads as a native tool', async () => {
  const boss = delegating('claude-sonnet-4-6');
  await secondRequest(boss, delegateConfig(['web_search'], 'scripted/claude'));
  // The ModelRequest the loop sent the Claude model.
  const sent = boss.adapter.requests[1];
  assert.equal(sent.model, 'claude-sonnet-4-6');
  assert.deepEqual(sent.nativeTools, ['web_search']);
  const names = (sent.tools ?? []).map((t) => t.name);
  assert.ok(names.includes('Scout'));
  assert.ok(!names.includes('web_search'), 'the sentinel is not a client tool');
  // A non-Gemini LlmRequest carries the sentinel in toolsDict, with no Gemini grounding object: it reads as the native tool.
  const mapped = llmRequestToModelRequest(bareRequest({ model: 'claude-sonnet-4-6', toolsDict: { web_search: WEB_SEARCH_MARKER } as any }));
  assert.deepEqual(mapped.nativeTools, ['web_search']);
  assert.equal(mapped.tools, undefined, 'and declares no client tool');
});

function bareRequest(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: 'gemini-3.5-flash', contents: [], toolsDict: {}, liveConnectConfig: {}, ...over } as LlmRequest;
}

test('LlmRequest: the output schema, tool choice, sampling, stream and signal', () => {
  const calc = { name: 'calc', description: 'Calculate', parameters: { type: 'OBJECT', properties: { a: { type: 'NUMBER' } } } };
  const signal = new AbortController().signal;
  const mapped = llmRequestToModelRequest(
    bareRequest({
      toolsDict: { calc, x_search: X_SEARCH_MARKER, collections_search: COLLECTIONS_SEARCH_MARKER } as any,
      config: {
        responseSchema: { type: 'OBJECT' as never, properties: { answer: { type: 'STRING' as never } }, required: ['answer'] },
        responseMimeType: 'application/json',
        toolConfig: { functionCallingConfig: { mode: 'ANY' as never, allowedFunctionNames: ['calc'] } },
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 512,
        stopSequences: ['END'],
        topK: 40,
        abortSignal: signal,
        tools: [{ urlContext: {} }, { codeExecution: {} }, { googleSearch: {} }],
      },
    }),
    { stream: true },
  );
  assert.deepEqual(mapped.outputSchema, { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] });
  assert.deepEqual(mapped.toolChoice, { name: 'calc' });
  assert.deepEqual(mapped.tools, [{ name: 'calc', description: 'Calculate', parameters: { type: 'object', properties: { a: { type: 'number' } } } }]);
  assert.deepEqual(mapped.nativeTools, ['x_search', 'collections_search', 'url_context', 'code_execution', 'web_search']);
  assert.deepEqual(mapped.sampling, { temperature: 0.2, topP: 0.9, maxOutputTokens: 512, stop: ['END'] }, 'topK has no contract field');
  assert.equal(mapped.stream, true);
  assert.equal(mapped.signal, signal);
  assert.equal(mapped.system, undefined);

  const other = new AbortController().signal;
  assert.equal(llmRequestToModelRequest(bareRequest({ config: { abortSignal: signal } }), { signal: other }).signal, other, "the caller's signal wins");

  const mode = (m: string, names?: string[]) =>
    llmRequestToModelRequest(bareRequest({ toolsDict: { calc } as any, config: { toolConfig: { functionCallingConfig: { mode: m as never, allowedFunctionNames: names } } } }));
  assert.equal(mode('NONE').toolChoice, 'none');
  assert.equal(mode('ANY').toolChoice, 'required');
  assert.equal(mode('ANY', ['a', 'b']).toolChoice, 'required');
  assert.equal(mode('AUTO').toolChoice, undefined);
  const validated = mode('VALIDATED');
  assert.equal(validated.toolChoice, undefined);
  assert.equal(validated.tools?.[0].strict, true);

  assert.deepEqual(llmRequestToModelRequest(bareRequest({ config: { responseJsonSchema: { type: 'object', properties: {} } } })).outputSchema, { type: 'object', properties: {} });
  // Gemini's dialect is converted once, nullable and int64 bounds included (toContractJsonSchema).
  const nullable = llmRequestToModelRequest(
    bareRequest({ config: { responseSchema: { type: 'OBJECT' as never, properties: { note: { type: 'STRING' as never, nullable: true, maxLength: '80' as never } } } } }),
  ).outputSchema as any;
  assert.deepEqual(nullable.properties.note, { type: ['string', 'null'], maxLength: 80 });
  assert.equal(llmRequestToModelRequest(bareRequest(), { model: 'gemini-2.5-pro' }).model, 'gemini-2.5-pro');
  assert.throws(() => llmRequestToModelRequest(bareRequest({ model: undefined })), /names no model/);
});

test("LlmRequest: responseMimeType application/json without a schema is outputFormat 'json' (JSON mode, ADR 0061)", () => {
  assert.equal(llmRequestToModelRequest(bareRequest({ config: { responseMimeType: 'application/json' } })).outputFormat, 'json');
  const schema = llmRequestToModelRequest(bareRequest({ config: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: {} } } }));
  assert.equal(schema.outputFormat, undefined, 'a schema rides in outputSchema, which says more');
  assert.ok(schema.outputSchema);
  const gemini = llmRequestToModelRequest(bareRequest({ config: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' as never, properties: {} } } }));
  assert.equal(gemini.outputFormat, undefined, "Gemini's dialect is a schema too");
  assert.equal(llmRequestToModelRequest(bareRequest({ config: { responseMimeType: 'text/plain' } })).outputFormat, undefined);
  assert.equal(llmRequestToModelRequest(bareRequest()).outputFormat, undefined);
});

test('LlmRequest: the reasoning fields map to a ReasoningSetting where it is exact', () => {
  const cases: Array<[Record<string, unknown>, unknown]> = [
    [{ thinkingConfig: { thinkingLevel: 'MINIMAL' }, reasoningEffort: 'none' }, 'none'],
    [{ thinkingConfig: { thinkingLevel: 'LOW' } }, 'low'],
    [{ thinkingConfig: { thinkingLevel: 'MEDIUM' } }, 'medium'],
    [{ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }, 'high'],
    [{ thinkingConfig: { thinkingBudget: 8192 }, reasoningEffort: 'medium' }, { budget_tokens: 8192 }],
    [{ thinkingConfig: { thinkingBudget: 0 } }, { budget_tokens: 0 }],
    [{ thinkingConfig: { thinkingBudget: -1 } }, undefined],
    [{ thinkingConfig: { includeThoughts: true } }, undefined],
    [{ thinkingConfig: { thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED' } }, undefined],
    [{ reasoningEffort: 'low' }, 'low'],
    [{ reasoningEffort: 'high' }, 'high'],
    [{ reasoningEffort: 'minimal' }, 'none'],
    // The words above high (ADR 0117): alone, or beside the thinkingConfig
    // the compiler writes for them (HIGH, or high's budget); a thinkingConfig
    // that says less keeps its own reading.
    [{ reasoningEffort: 'xhigh' }, 'xhigh'],
    [{ reasoningEffort: 'max' }, 'max'],
    [{ thinkingConfig: { thinkingLevel: 'HIGH' }, reasoningEffort: 'max' }, 'max'],
    [{ thinkingConfig: { thinkingBudget: 16384 }, reasoningEffort: 'xhigh' }, 'xhigh'],
    [{ thinkingConfig: { includeThoughts: true }, reasoningEffort: 'max' }, 'max'],
    [{ thinkingConfig: { thinkingLevel: 'LOW' }, reasoningEffort: 'max' }, 'low'],
    [{ thinkingConfig: { thinkingBudget: 4096 }, reasoningEffort: 'max' }, { budget_tokens: 4096 }],
    [{ reasoningEffort: 'ultra' }, undefined],
    [{}, undefined],
  ];
  for (const [config, expected] of cases) assert.deepEqual(reasoningOf(config as never), expected, JSON.stringify(config));
  assert.equal('reasoning' in llmRequestToModelRequest(bareRequest()), false);
  // Words that name an Object.prototype member read as nothing.
  for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(reasoningOf({ reasoningEffort: word } as never), undefined, word);
    assert.equal(reasoningOf({ thinkingConfig: { thinkingLevel: word } } as never), undefined, word);
  }
});

// ── ModelResponse → LlmResponse ──────────────────────────────────────────────

test('ModelResponse: a final maps to content, usage, finish reason and grounding', () => {
  const llm = modelResponseToLlmResponse({
    partial: false,
    parts: [
      { type: 'text', text: 'MU is at 101.', providerState: gemini(THOUGHT_SIGNATURE_KIND, 'sig') },
      { type: 'toolCall', id: 'adk-1', name: 'quote', args: { t: 'MU' } },
      { type: 'toolCall', id: `${MINTED_CALL_ID_PREFIX}0-0`, name: 'quote', args: { t: 'NVDA' } },
    ],
    finishReason: 'tool_call',
    usage: { inputTokens: 1000, outputTokens: 300, thinkingTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 50 },
    grounding: {
      citations: [
        { url: 'https://a.test/1', title: 'A', start: 0, end: 5 },
        { url: 'https://a.test/1', title: 'A' },
        { url: 'https://b.test/2' },
      ],
      searchQueries: [{ tool: 'web_search', query: 'MU price' }, { tool: 'x_search', query: 'MU' }],
    },
  });
  assert.deepEqual(llm, {
    content: {
      role: 'model',
      parts: [
        { text: 'MU is at 101.', thoughtSignature: 'sig' },
        { functionCall: { name: 'quote', args: { t: 'MU' }, id: 'adk-1' } },
        { functionCall: { name: 'quote', args: { t: 'NVDA' } } },
      ],
    },
    finishReason: 'STOP',
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 200, cachedContentTokenCount: 400, totalTokenCount: 1300 },
    groundingMetadata: {
      webSearchQueries: ['MU price', 'MU'],
      groundingChunks: [{ web: { uri: 'https://a.test/1', title: 'A' } }, { web: { uri: 'https://b.test/2' } }],
    },
    turnComplete: true,
  });
  assert.deepEqual(usageFromMetadata(llm.usageMetadata), { inputTokens: 1000, outputTokens: 300, thinkingTokens: 200, cacheReadTokens: 400 }, 'usage round-trips but for cache writes');
});

test('ModelResponse: a partial streams its deltas, and a failure is an error code', () => {
  assert.deepEqual(modelResponseToLlmResponse({ partial: true, parts: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'MU' }] }), {
    content: { role: 'model', parts: [{ text: 'hmm', thought: true }, { text: 'MU' }] },
    partial: true,
  });
  const cut = modelResponseToLlmResponse({
    partial: false,
    parts: [],
    finishReason: 'max_tokens',
    usage: { inputTokens: 10, outputTokens: 4096, thinkingTokens: 4096 },
    error: { code: 'OLLAMA_MAX_TOKENS', message: 'out of tokens', retryable: false },
  });
  assert.equal(cut.finishReason, 'MAX_TOKENS');
  assert.equal(cut.errorCode, 'OLLAMA_MAX_TOKENS');
  assert.equal(cut.usageMetadata?.candidatesTokenCount, 0);
  for (const [reason, genai] of [['stop', 'STOP'], ['content_filter', 'SAFETY'], ['other', 'OTHER']] as const) {
    const ok = modelResponseToLlmResponse({ partial: false, parts: [{ type: 'text', text: 'x' }], finishReason: reason });
    assert.equal(ok.finishReason, genai);
    assert.equal(ok.customMetadata, undefined, 'a response that did not fail carries no verdict');
  }
});

test('ModelResponse: an error carries its retry verdict on customMetadata (ADR 0044)', () => {
  const failed = (error: { code: string; message: string; retryable: boolean; status?: number }) =>
    modelResponseToLlmResponse({ partial: false, parts: [], finishReason: 'error', error });

  const overloaded = failed({ code: 'ANTHROPIC_ERROR', message: '529 overloaded', retryable: true, status: 529 });
  assert.deepEqual(overloaded, {
    errorCode: 'ANTHROPIC_ERROR',
    errorMessage: '529 overloaded',
    turnComplete: true,
    customMetadata: { [ERROR_RETRYABLE_KEY]: true, [ERROR_STATUS_KEY]: 529 },
  });
  assert.equal(overloaded.customMetadata?.[ERROR_RETRYABLE_KEY], true, 'a fallback model answers it');

  const bad = failed({ code: 'ANTHROPIC_ERROR', message: '400 invalid_request_error', retryable: false, status: 400 });
  assert.deepEqual(bad.customMetadata, { [ERROR_RETRYABLE_KEY]: false, [ERROR_STATUS_KEY]: 400 });
  assert.equal(bad.customMetadata?.[ERROR_RETRYABLE_KEY], false, 'the request is at fault: passed on');

  const unreachable = failed({ code: 'OLLAMA_UNREACHABLE', message: 'connection refused', retryable: true });
  assert.deepEqual(unreachable.customMetadata, { [ERROR_RETRYABLE_KEY]: true });
  assert.equal(ERROR_STATUS_KEY in unreachable.customMetadata!, false, 'no status, no error.status key');
  assert.equal(unreachable.customMetadata?.[ERROR_RETRYABLE_KEY], true);

  // The message leaves the mapping with key-shaped text scrubbed, as every adapter's error does.
  const leaked = failed({ code: 'OPENAI_ERROR', message: 'bad key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', retryable: false, status: 401 });
  assert.doesNotMatch(leaked.errorMessage ?? '', /sk-proj-abcdefghijklmnopqrstuvwxyz0123456789/);
});

test('ModelResponse: an error code that is a Gemini finish reason is the finish reason too, as ADK\'s Gemini reports it (ADR 0088)', () => {
  const failed = (code: string, finishReason: 'other' | 'content_filter' | 'error' = 'other') =>
    modelResponseToLlmResponse({ partial: false, parts: [], finishReason, error: { code, message: `Gemini stopped without an answer (${code}).`, retryable: false } });
  const malformed = failed('MALFORMED_FUNCTION_CALL');
  assert.equal(malformed.finishReason, 'MALFORMED_FUNCTION_CALL', 'the reflect-and-retry plugin reads it here');
  assert.equal(malformed.errorCode, 'MALFORMED_FUNCTION_CALL');
  assert.equal(failed('RECITATION', 'content_filter').finishReason, 'RECITATION', 'not flattened to SAFETY');
  assert.equal(failed('UNEXPECTED_TOOL_CALL').finishReason, 'UNEXPECTED_TOOL_CALL');
  // Any other code keeps the contract's finish reason.
  assert.equal(failed('ANTHROPIC_ERROR', 'error').finishReason, undefined);
  assert.equal(failed('GEMINI_ERROR', 'error').finishReason, undefined);
  assert.equal(failed('UNKNOWN_ERROR', 'error').finishReason, undefined);
  assert.equal(failed('STOP').finishReason, 'OTHER', 'STOP is never an error\'s finish reason');
  // And back: the contract reads the same error and finish reason it started from.
  const back = llmResponseToModelResponse(malformed);
  assert.equal(back.partial, false);
  assert.deepEqual(back.partial === false && [back.finishReason, back.error?.code], ['other', 'MALFORMED_FUNCTION_CALL']);
});

test('usage: Gemini usageMetadata reads under the contract meanings', () => {
  assert.deepEqual(
    usageFromMetadata({ promptTokenCount: 900, toolUsePromptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, cachedContentTokenCount: 300 }),
    { inputTokens: 1000, outputTokens: 75, thinkingTokens: 25, cacheReadTokens: 300 },
  );
  assert.equal(usageFromMetadata({}), undefined);
  assert.equal(usageFromMetadata(undefined), undefined);
  assert.deepEqual(usageToMetadata({ inputTokens: 5, outputTokens: 7 }), { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 });
});

// ── The reverse: ModelRequest → LlmRequest ───────────────────────────────────

const signatureState = (payload: string, model?: string): ProviderState => ({ provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, ...(model ? { model } : {}), payload });

const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', enum: ['cat', 'dog'], description: 'What to look up' },
    limit: { type: ['integer', 'null'], minimum: 1 },
    filters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'], additionalProperties: false } },
  },
  required: ['q'],
};

test('ModelRequest → LlmRequest → ModelRequest gives back every field an LlmRequest can hold', () => {
  const signal = new AbortController().signal;
  const request: ModelRequest = {
    model: 'gemini-3-flash',
    system: 'Be brief.',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'Look up cat.' }, { type: 'blob', mimeType: 'application/pdf', url: 'https://example.test/a.pdf' }] },
      { role: 'assistant', parts: [{ type: 'toolCall', id: 'adk-1', name: 'lookup', args: { q: 'cat' }, providerState: signatureState('c2ln') }] },
      { role: 'tool', parts: [{ type: 'toolResult', id: 'adk-1', name: 'lookup', result: { definition: 'a feline' } }] },
    ],
    tools: [{ name: 'lookup', description: 'Looks a word up.', parameters: LOOKUP_SCHEMA, strict: true }],
    nativeTools: ['url_context', 'web_search', 'code_execution'],
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    reasoning: 'high',
    sampling: { temperature: 0.2, topP: 0.9, maxOutputTokens: 512, stop: ['END'] },
    signal,
  };
  const llm = modelRequestToLlmRequest(request);
  assert.deepEqual(llmRequestToModelRequest(llm), request);
  assert.deepEqual(request.tools![0].parameters, LOOKUP_SCHEMA, 'the input is not mutated');

  // What Gemini is sent: config.tools, the lowercase schema as written, the mode, thinking and the effort word.
  assert.deepEqual(llm.config?.tools, [
    { functionDeclarations: [{ name: 'lookup', description: 'Looks a word up.', parametersJsonSchema: LOOKUP_SCHEMA }] },
    { urlContext: {} },
    { googleSearch: {} },
    { codeExecution: {} },
  ]);
  assert.deepEqual(llm.config?.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } });
  assert.deepEqual(llm.config?.thinkingConfig, { thinkingLevel: 'HIGH' });
  assert.equal((llm.config as Record<string, unknown>).reasoningEffort, 'high');
  assert.equal(llm.config?.systemInstruction, 'Be brief.');
  assert.equal(llm.config?.abortSignal, signal);
  // An adapter that reads toolsDict reads the same declaration out of it.
  assert.deepEqual(contractToolDeclaration(llm.toolsDict.lookup), { name: 'lookup', description: 'Looks a word up.', parameters: LOOKUP_SCHEMA });

  for (const toolChoice of ['none', 'required', { name: 'lookup' }] as const) {
    const forced: ModelRequest = { model: 'gemini-3-flash', messages: [], tools: [{ name: 'lookup', description: '', parameters: LOOKUP_SCHEMA }], toolChoice };
    assert.deepEqual(llmRequestToModelRequest(modelRequestToLlmRequest(forced)), forced, JSON.stringify(toolChoice));
  }
  for (const reasoning of ['none', 'low', 'medium', { budget_tokens: 4096 }] as const) {
    const thinking: ModelRequest = { model: 'gemini-3-flash', messages: [], reasoning };
    assert.deepEqual(llmRequestToModelRequest(modelRequestToLlmRequest(thinking)), thinking, JSON.stringify(reasoning));
  }
  // JSON mode: the MIME type alone, and back.
  const jsonMode: ModelRequest = { model: 'gemini-3-flash', messages: [], outputFormat: 'json' };
  const jsonLlm = modelRequestToLlmRequest(jsonMode);
  assert.equal(jsonLlm.config?.responseMimeType, 'application/json');
  assert.equal(jsonLlm.config?.responseJsonSchema, undefined);
  assert.deepEqual(llmRequestToModelRequest(jsonLlm), jsonMode);
});

test('the reverse request mapping: what does not come back the same', () => {
  const back = (over: Partial<ModelRequest>) => llmRequestToModelRequest(modelRequestToLlmRequest({ model: 'gemini-3-flash', messages: [], ...over }));
  const tool = { name: 'lookup', description: '', parameters: LOOKUP_SCHEMA };

  assert.deepEqual(back({ nativeTools: ['google_search', 'web_search'] }).nativeTools, ['web_search'], "google_search is Gemini's googleSearch, read as web_search");
  assert.deepEqual(modelRequestToLlmRequest({ model: 'gemini-3-flash', messages: [], nativeTools: ['google_search', 'web_search'] }).config?.tools, [{ googleSearch: {} }], 'sent once');
  assert.equal(back({ nativeTools: ['x_search', 'collections_search'] }).nativeTools, undefined, 'Gemini has no tool for these');
  assert.deepEqual(nativeToolsWithoutGeminiTool(['x_search', 'web_search', 'collections_search', 'x_search']), ['x_search', 'collections_search']);
  assert.equal(back({ tools: [tool], toolChoice: 'auto' }).toolChoice, undefined, 'auto is the default, and reads as absent');
  assert.equal(back({ toolChoice: 'none' }).toolChoice, undefined, 'a choice without tools is not sent');
  assert.deepEqual(back({ tools: [tool, { ...tool, name: 'other', strict: true }] }).tools?.map((t) => t.strict), [true, true], 'strict is per request on Gemini');
  const forcedStrict = back({ tools: [{ ...tool, strict: true }], toolChoice: 'required' });
  assert.equal(forcedStrict.toolChoice, 'required');
  assert.equal(forcedStrict.tools?.[0].strict, undefined, 'strict is lost beside a forced choice');
  assert.deepEqual(back({ model: 'gemini-2.5-flash', reasoning: 'low' }).reasoning, { budget_tokens: 2048 }, 'a level Gemini 2.x takes as a budget reads back as the budget');
  assert.equal(back({ model: 'o3', reasoning: 'none' }).reasoning, 'low', 'a level a model cannot take reads back as its rendering');
  assert.equal(back({ stream: true }).stream, undefined, 'stream is not an LlmRequest field');
  const both = back({ outputSchema: { type: 'object', properties: {} }, outputFormat: 'json' });
  assert.equal(both.outputFormat, undefined, "outputFormat 'json' beside a schema reads back as the schema alone");
  assert.deepEqual(both.outputSchema, { type: 'object', properties: {} });
  assert.equal(modelRequestToLlmRequest({ model: 'gemini-3-flash', messages: [], system: '' }).config?.systemInstruction, undefined, 'an empty system prompt is none');

  // System messages stay system contents; the Gemini wrapper folds them into the system prompt.
  const system: Message = { role: 'system', parts: [{ type: 'text', text: 'Turn note.' }] };
  assert.deepEqual(modelRequestToLlmRequest({ model: 'gemini-3-flash', messages: [system] }).contents, [{ role: 'system', parts: [{ text: 'Turn note.' }] }]);
  assert.deepEqual(back({ messages: [system] }).messages, [system]);
});

test('every fixture history, as an LlmRequest carries it, round-trips LlmRequest → ModelRequest → LlmRequest, and back', () => {
  let histories = 0;
  for (const { name, contents: rows } of allFixtures()) {
    for (const stored of rows) {
      for (const contents of [stored, asRequestContents(stored)]) {
        const llm = bareRequest({ contents, config: { systemInstruction: 'You keep the fixtures.' } });
        const mapped = llmRequestToModelRequest(llm);
        const back = modelRequestToLlmRequest(mapped);
        assert.equal(canonical(back.contents), canonical(contents), `${name}: the contents come back byte-equal`);
        assert.equal(back.config?.systemInstruction, 'You keep the fixtures.');
        assert.equal(back.model, llm.model);
        assert.deepEqual(llmRequestToModelRequest(back), mapped, `${name}: ModelRequest → LlmRequest → ModelRequest is stable`);
        histories++;
      }
    }
  }
  assert.ok(histories >= 20, `only ${histories} histories were checked`);
});

test('the LlmRequest a native turn sent round-trips through the contract', async () => {
  const boss = delegating('scripted/boss');
  const request = await secondRequest(boss, delegateConfig(['load_memory', 'web_search']));
  const mapped = llmRequestToModelRequest(request);
  const back = modelRequestToLlmRequest(mapped);
  assert.equal(canonical(back.contents), canonical(request.contents));
  assert.equal(back.config?.systemInstruction, request.config!.systemInstruction);
  assert.deepEqual(back.config?.thinkingConfig, request.config!.thinkingConfig, 'reasoning: high, as the compiler wrote it');
  assert.ok(((back.config?.tools ?? []) as Array<{ googleSearch?: unknown }>).some((t) => t.googleSearch), "web_search comes back as Gemini's googleSearch");
  assert.deepEqual(Object.keys(back.toolsDict).sort(), Object.keys(request.toolsDict).sort(), 'every declared tool, in toolsDict');
  assert.deepEqual(llmRequestToModelRequest(back), mapped);
});

// ── The reverse: LlmResponse → ModelResponse ─────────────────────────────────

test('every model event of every fixture round-trips LlmResponse → ModelResponse → LlmResponse; thinking stays out of the final', () => {
  let events = 0;
  let withThinking = 0;
  for (const { name, fixture } of allFixtures()) {
    for (const row of fixture.sessions) {
      row.events.forEach((event, i) => {
        const llm = event as unknown as LlmResponse;
        if (llm.content?.role !== 'model') return;
        const final = llmResponseToModelResponse(llm, { index: i });
        assert.equal(final.partial, false, `${name} event ${i}: a stored event is a final`);
        const back = modelResponseToLlmResponse(final);
        const output = (llm.content.parts ?? []).filter((p) => p.thought !== true);
        if (output.length < (llm.content.parts ?? []).length) withThinking++;
        assert.equal(canonical(back.content?.parts ?? []), canonical(output), `${name} event ${i}: its output parts come back byte-equal`);
        if (llm.usageMetadata) assert.deepEqual(back.usageMetadata, llm.usageMetadata, `${name} event ${i}: usage`);
        if (llm.finishReason) assert.equal(back.finishReason, llm.finishReason, `${name} event ${i}: finish reason`);
        assert.deepEqual(llmResponseToModelResponse(back, { index: i }), final, `${name} event ${i}: ModelResponse → LlmResponse → ModelResponse is stable`);
        events++;
      });
    }
  }
  assert.ok(events >= 15, `only ${events} model events were checked`);
  assert.ok(withThinking >= 2, 'the thought-signature fixtures were covered');
});

test('ModelResponse → LlmResponse → ModelResponse: finals, failures and partials come back the same', () => {
  const MODEL = 'gemini-3-flash';
  const responses: ModelResponse[] = [
    {
      partial: false,
      parts: [
        { type: 'text', text: 'MU is at 101.', providerState: signatureState('a', MODEL) },
        { type: 'toolCall', id: 'adk-1', name: 'quote', args: { t: 'MU' }, providerState: signatureState('b', MODEL) },
        { type: 'toolCall', id: `${MINTED_CALL_ID_PREFIX}4-2`, name: 'quote', args: { t: 'NVDA' } },
        { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
      finishReason: 'tool_call',
      usage: { inputTokens: 1000, outputTokens: 300, thinkingTokens: 200, cacheReadTokens: 400 },
      grounding: { citations: [{ url: 'https://a.test/1', title: 'A' }, { url: 'https://b.test/2' }], searchQueries: [{ tool: 'web_search', query: 'MU price' }] },
    },
    { partial: false, parts: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 } },
    { partial: false, parts: [], finishReason: 'stop' },
    { partial: false, parts: [], finishReason: 'error', error: { code: 'ANTHROPIC_ERROR', message: '529 overloaded', retryable: true, status: 529 } },
    { partial: false, parts: [], finishReason: 'error', error: { code: 'STEP_LIMIT', message: 'The turn reached its limit.', retryable: false } },
    { partial: false, parts: [{ type: 'text', text: 'Cut' }], finishReason: 'max_tokens', error: { code: 'MAX_TOKENS', message: 'out of tokens', retryable: false } },
    { partial: false, parts: [], finishReason: 'content_filter', error: { code: 'SAFETY', message: 'withheld', retryable: false } },
    { partial: false, parts: [{ type: 'text', text: 'Hmm.' }], finishReason: 'other' },
    { partial: true, parts: [{ type: 'thinking', text: 'Weighing it.' }, { type: 'text', text: 'MU' }] },
  ];
  for (const response of responses) {
    assert.deepEqual(llmResponseToModelResponse(modelResponseToLlmResponse(response), { model: MODEL, index: 4 }), response, JSON.stringify(response).slice(0, 80));
  }
  // Without `model`, a signature names none, as genai records none; the search tool is the caller's to say.
  const grounded = modelResponseToLlmResponse(responses[0]);
  const plain = llmResponseToModelResponse(grounded, { index: 4, searchTool: 'google_search' }) as FinalModelResponse;
  assert.deepEqual(plain.parts[0].providerState, signatureState('a'));
  assert.deepEqual(plain.grounding?.searchQueries, [{ tool: 'google_search', query: 'MU price' }]);
});

test('LlmResponse → ModelResponse: a thought signature moves to the next part, STOP is no error, the verdict reads back', () => {
  const read = (response: LlmResponse) => llmResponseToModelResponse(response, { model: 'gemini-3-flash', index: 3 }) as FinalModelResponse;

  const moved = read({
    content: { role: 'model', parts: [{ text: 'hmm', thought: true, thoughtSignature: 's1' }, { functionCall: { name: 'f', args: {} } }, { text: 'more', thought: true, thoughtSignature: 's2' }] },
    finishReason: 'STOP' as never,
  });
  assert.deepEqual(
    moved,
    {
      partial: false,
      parts: [{ type: 'toolCall', id: `${MINTED_CALL_ID_PREFIX}3-1`, name: 'f', args: {}, providerState: signatureState('s1', 'gemini-3-flash') }],
      finishReason: 'tool_call',
    },
    'a call keeps its own place; a trailing signature finds no part without state',
  );
  const trailing = read({ content: { role: 'model', parts: [{ text: 'Answer.' }, { text: 'x', thought: true, thoughtSignature: 's3' }] } });
  assert.deepEqual(trailing.parts, [{ type: 'text', text: 'Answer.', providerState: signatureState('s3', 'gemini-3-flash') }], 'a trailing signature stays with the last part');

  assert.deepEqual(read({ errorCode: 'STOP' }), { partial: false, parts: [], finishReason: 'stop' }, "ADK's empty STOP is no error");
  assert.deepEqual(
    read({ errorCode: 'SAFETY' }),
    { partial: false, parts: [], finishReason: 'content_filter', error: { code: 'SAFETY', message: 'The model call ended with SAFETY.', retryable: false } },
    'a blocked prompt',
  );
  assert.equal(read({ errorCode: 'UNKNOWN_ERROR', errorMessage: 'Unknown error.' }).finishReason, 'error');
  const verdict = read(withRetryVerdict({ errorCode: 'GEMINI_ERROR', errorMessage: 'key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 overloaded' }, { retryable: true, status: 503 }));
  assert.equal(verdict.error?.retryable, true);
  assert.equal(verdict.error?.status, 503);
  assert.doesNotMatch(verdict.error?.message ?? '', /sk-proj-abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal(read({ errorCode: 'X', customMetadata: { [ERROR_RETRYABLE_KEY]: 'yes' } }).error?.retryable, false, 'only a boolean true is retryable');

  // A partial holds text and thinking deltas only; a call streamed progressively waits for the final.
  assert.deepEqual(
    llmResponseToModelResponse({
      partial: true,
      content: { role: 'model', parts: [{ text: 'a' }, { functionCall: { name: 'f', args: {} } }, { text: '', thought: true }, { text: 'b', thought: true }] },
    }),
    { partial: true, parts: [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'b' }] },
  );
});
