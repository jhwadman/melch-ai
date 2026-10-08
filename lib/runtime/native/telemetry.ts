/**
 * lib/runtime/native/telemetry.ts — the native loop's spans: one per agent
 * run, one per model step, one per tool call (ADR 0076).
 *
 * WHY this file exists:
 *   The ledger (lib/observability/supabaseSpanExporter.ts) is a projection of
 *   a turn's spans. ADK opened `invoke_agent <name>` around an agent's run,
 *   `call_llm` around each step's model call and `execute_tool <name>`
 *   around each tool call; the tracer reads them to attribute a model call
 *   to its agent and to sum tool time, and the exporter reads `call_llm`
 *   for the payload tier (rows written before 1.0.0). A run writes the same
 *   ledger rows because the loop opens the same three spans under the
 *   engine's own names and scope:
 *
 *     agent.invoke <name>   the agent's run (runAgentLoop), parent of the rest
 *     model.call            one model step, parent of the step's llm.request
 *                           span(s): two when a fallback model answers
 *     tool.execute <name>   one tool call; a step's calls run side by side
 *
 *   All three are in scope `melchizedek.runtime`, which the console exporter
 *   keeps quiet as it kept ADK's (OTEL_CONSOLE_ALL_SPANS prints them).
 *
 * WHAT A SPAN CARRIES:
 *   gen_ai.* attributes as ADK set them (operation, agent, conversation,
 *   tool name and call id, request model, usage, finish reason), and on
 *   model.call the provider the answering adapter names (`gen_ai.system`),
 *   where ADK's call_llm named its own scope. A model step that did not fail
 *   carries its payload as the engine holds it: `llm.payload.request` (the
 *   ModelRequest, its signal left out) and `llm.payload.response` (the
 *   adapter's final response). A failed step carries none: its llm.request
 *   span carries the failed call's payload, as under ADK, where a failed
 *   call_llm never ended. With TELEMETRY_PAYLOADS=off no payload is
 *   recorded at all. Tool spans carry no arguments and no results: the root
 *   span's ToolCall/ToolResponse events are where the ledger keeps those.
 *
 * The loop calls three hooks (agentLoop.ts): traceAgentInvocation around the
 * whole run, traceModelCall around each step, traceToolCall around each call.
 */

import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';

import type { ModelAdapter } from '../../models/contract.ts';
import { resolveAdapter } from '../../models/registry.ts';
import { RUNTIME_SPAN_SCOPE } from '../../observability/lineage.ts';
import { payloadPolicyFromEnv } from '../../observability/supabaseSpanExporter.ts';
import { initializeTracing } from '../../observability/tracer.ts';
import type { TurnEvent, TurnFunctionCall, TurnPart } from '../events.ts';
import type { AgentLoopContext, AgentLoopEnd } from './agentLoop.ts';
import type { NativeAgent } from './request.ts';
import type { ModelStepResult } from './step.ts';
import type { NodeResult, TracedNode } from '../../workflow/scheduler.ts';

/** The most a payload attribute holds, as for a failed call's (lib/observability/tracer.ts). */
const PAYLOAD_MAX_CHARS = 200_000;

const runtimeTracer = () => trace.getTracer(RUNTIME_SPAN_SCOPE);

/** JSON that never throws and never exceeds the cap. */
function payloadJson(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length > PAYLOAD_MAX_CHARS ? json.slice(0, PAYLOAD_MAX_CHARS) : json;
}

/**
 * Runs `inner` with `spanContext` active for every step it takes, as ADK's
 * runAsyncGeneratorWithOtelContext does: spans the generator opens are
 * children of the span. A consumer that stops early closes `inner` too, so
 * its own spans end.
 */
async function* within<T, R>(spanContext: Context, inner: AsyncGenerator<T, R>): AsyncGenerator<T, R> {
  let finished = false;
  try {
    for (;;) {
      const next = await context.with(spanContext, () => inner.next());
      if (next.done) {
        finished = true;
        return next.value;
      }
      yield next.value;
    }
  } finally {
    if (!finished) await context.with(spanContext, () => inner.return(undefined as R));
  }
}

function failed(span: Span, error: unknown): never {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
  throw error;
}

/** The agent's run as an `agent.invoke <name>` span, opened when the run starts. */
export async function* traceAgentInvocation(
  agent: Pick<NativeAgent, 'name' | 'description'>,
  ctx: Pick<AgentLoopContext, 'session' | 'invocationId'>,
  run: () => AsyncGenerator<TurnEvent, AgentLoopEnd>,
): AsyncGenerator<TurnEvent, AgentLoopEnd> {
  initializeTracing();
  const span = runtimeTracer().startSpan(`agent.invoke ${agent.name}`, {
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agent.name,
      'gen_ai.agent.description': agent.description ?? '',
      'gen_ai.conversation.id': ctx.session.id,
      'adk.invocation_id': ctx.invocationId,
    },
  });
  try {
    const end = yield* within(trace.setSpan(context.active(), span), run());
    span.setAttribute('agent.end_reason', end.reason);
    span.setAttribute('agent.steps', end.steps);
    if (end.stop) span.setAttribute('agent.stop_code', end.stop.code);
    return end;
  } catch (error) {
    return failed(span, error);
  } finally {
    span.end();
  }
}

/**
 * One model step as a `model.call` span. `step` gets the loop's context with
 * an `adapterFor` that notes the adapter it hands out, so the span names the
 * provider that answered (the fallback's, when a fallback answered).
 */
export async function* traceModelCall(
  agent: Pick<NativeAgent, 'name' | 'model'>,
  ctx: AgentLoopContext,
  step: (traced: AgentLoopContext) => AsyncGenerator<TurnEvent, ModelStepResult>,
): AsyncGenerator<TurnEvent, ModelStepResult> {
  initializeTracing();
  const span = runtimeTracer().startSpan('model.call', {
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.agent.name': agent.name,
      'llm.agent': agent.name,
      'gen_ai.request.model': agent.model,
      'gen_ai.conversation.id': ctx.session.id,
      'adk.invocation_id': ctx.invocationId,
    },
  });
  let provider: string | undefined;
  const adapterFor = ctx.adapterFor ?? resolveAdapter;
  const traced: AgentLoopContext = {
    ...ctx,
    adapterFor: (model: string): ModelAdapter => {
      const adapter = adapterFor(model);
      provider = adapter.provider;
      return adapter;
    },
  };
  try {
    const result = yield* within(trace.setSpan(context.active(), span), step(traced));
    recordModelCall(span, result, provider);
    return result;
  } catch (error) {
    return failed(span, error);
  } finally {
    span.end();
  }
}

function recordModelCall(span: Span, result: ModelStepResult, provider: string | undefined): void {
  // gen_ai.request.model stays the agent's model, as on ADK's call_llm; the
  // llm.request span (and the payload's request) name the leaf that answered.
  if (provider) span.setAttribute('gen_ai.system', provider);
  const response = result.response;
  if (response?.usage) {
    span.setAttribute('gen_ai.usage.input_tokens', response.usage.inputTokens);
    span.setAttribute('gen_ai.usage.output_tokens', response.usage.outputTokens);
  }
  if (response?.finishReason) span.setAttribute('gen_ai.response.finish_reasons', [response.finishReason]);
  if (result.stopped) {
    span.setAttribute('model.call.stop_code', result.stopped.code);
    return;
  }
  if (!response) return;
  if (response.error) {
    // The failed call's payload is on its llm.request span; the code alone here.
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('llm.error_code', String(response.error.code));
    return;
  }
  if (payloadPolicyFromEnv().mode === 'off') return;
  const { signal: _signal, ...request } = result.request;
  span.setAttribute('llm.payload.request', payloadJson(request));
  span.setAttribute('llm.payload.response', payloadJson(response));
}

/** One tool call as a `tool.execute <name>` span, under the agent's. */
export async function traceToolCall<O extends { part?: TurnPart } | undefined>(
  call: TurnFunctionCall,
  tool: unknown,
  run: () => Promise<O>,
): Promise<O> {
  initializeTracing();
  const name = call.name || '<unnamed>';
  const description = tool && typeof tool === 'object' ? (tool as { description?: unknown }).description : undefined;
  const span = runtimeTracer().startSpan(`tool.execute ${name}`, {
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': name,
      'gen_ai.tool.description': typeof description === 'string' ? description : '',
      ...(call.id ? { 'gen_ai.tool.call.id': call.id } : {}),
    },
  });
  try {
    const outcome = await context.with(trace.setSpan(context.active(), span), run);
    const response = outcome?.part?.functionResponse?.response as Record<string, unknown> | undefined;
    if (!outcome?.part) span.setAttribute('tool.pending', true);
    else if (response && Object.hasOwn(response, 'error')) {
      // The error text can quote the person's words; the response event holds it.
      span.setAttribute('tool.error', true);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return outcome;
  } catch (error) {
    return failed(span, error);
  } finally {
    span.end();
  }
}

// ── A workflow's spans (ADR 0095) ────────────────────────────────────────────
// ADK opens `invoke_workflow <name>` around a workflow's walk, `execute_node
// <name>` around each node run (a map item's under its map's), and
// `execute_tool <name>` around a tool node's call. The native walk opens the
// same three under the engine's names, `workflow.invoke`, `node.execute` and
// `tool.execute`, with ADK's attributes. An agent node's own `agent.invoke`
// (traceAgentInvocation, above) opens inside its node's span, so the ledger
// attributes each model call to the node's agent, as on ADK.

/** The walk as a `workflow.invoke <name>` span; every node span opens under it. */
export async function traceWorkflowInvocation<T>(
  workflow: { name: string; path: string },
  ctx: { sessionId: string; invocationId: string },
  run: () => Promise<T>,
): Promise<T> {
  initializeTracing();
  const span = runtimeTracer().startSpan(`workflow.invoke ${workflow.name}`, {
    attributes: {
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.conversation.id': ctx.sessionId,
      'adk.workflow.name': workflow.name,
      'adk.node.path': workflow.path,
      'adk.invocation_id': ctx.invocationId,
    },
  });
  try {
    return await context.with(trace.setSpan(context.active(), span), run);
  } catch (error) {
    return failed(span, error);
  } finally {
    span.end();
  }
}

/**
 * One node run as a `node.execute <name>` span (the scheduler's traceNode
 * hook): every attempt of the run inside it, ending with ADK's status
 * (`completed`, `waiting` when the run paused on a person, `failed`) and the
 * attempts the run made.
 */
export async function traceNodeExecution(node: TracedNode, run: () => Promise<NodeResult>): Promise<NodeResult> {
  initializeTracing();
  const span = runtimeTracer().startSpan(`node.execute ${node.name}`, {
    attributes: {
      'gen_ai.operation.name': 'execute_node',
      'adk.node.path': node.path,
      'adk.node.run_id': node.runId,
      'adk.node.kind': node.kind,
    },
  });
  const settle = (status: 'completed' | 'waiting' | 'failed', interrupts: number) =>
    span.setAttributes({ 'adk.node.attempt': node.attempts.count, 'adk.node.status': status, 'adk.node.interrupt_count': interrupts });
  try {
    const result = await context.with(trace.setSpan(context.active(), span), run);
    const interrupts = result.interruptIds?.length ?? 0;
    settle(interrupts > 0 ? 'waiting' : 'completed', interrupts);
    return result;
  } catch (error) {
    settle('failed', 0);
    return failed(span, error);
  } finally {
    span.end();
  }
}

/** A tool node's call as a `tool.execute <name>` span, under its node's (ToolNodeContext.traceCall). */
export async function traceToolNodeCall<T>(call: { id: string; name: string }, tool: unknown, run: () => Promise<T>): Promise<T> {
  initializeTracing();
  const description = tool && typeof tool === 'object' ? (tool as { description?: unknown }).description : undefined;
  const span = runtimeTracer().startSpan(`tool.execute ${call.name}`, {
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.description': typeof description === 'string' ? description : '',
      'gen_ai.tool.call.id': call.id,
    },
  });
  try {
    return await context.with(trace.setSpan(context.active(), span), run);
  } catch (error) {
    // The tool node turns the throw into its { error } response; the span notes the failure, not the message.
    span.setAttribute('tool.error', true);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
