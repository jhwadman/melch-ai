/**
 * lib/wiki/agentRun.ts — one-shot agent execution for wiki operations.
 *
 * WHY this file exists:
 *   Three wiki operations need a model in the loop — gap-fill (write the
 *   prose a structural build can't), wiki_query (answer a question over the
 *   bundle), wiki_garden (author or revise a document). Each is a single
 *   agent run: build an ADK LlmAgent, hand it the wiki FunctionTools it
 *   needs, stream one exchange, return the text. This helper is that idiom
 *   (the same one scripts/demo_model_optionality.ts uses), shared so the
 *   three call sites can't drift.
 *
 *   Model routing goes through lib/models/registry.ts, so the YAML-style
 *   model string ('gemini-3.8-flash', 'claude-*', 'ollama/*'…) picks the
 *   provider — wiki operations inherit the framework's full model
 *   optionality. A missing provider key degrades to a clear error string;
 *   nothing here throws for want of credentials.
 *
 *   The runtime follows the turn runner's flag (lib/runtime/runtimeFlag.ts):
 *   MELCHIZEDEK_RUNTIME, or the run's `runtime` option. On `native` the
 *   same agent runs on the engine's own loop (lib/runtime/nativeTurn.ts),
 *   each wiki FunctionTool as the own Tool behind it, and its events are
 *   read the same way.
 */

import { randomUUID } from 'node:crypto';

import type { FunctionTool } from '@google/adk';

import { requireAdk } from '../adkPeer.ts';

import type { ModelAdapter } from '../models/contract.ts';
import {
  providerForModel,
  providerKeyPresent,
  registerAvailableProviders,
  resolveAdapter,
} from '../models/registry.ts';
import type { TurnEvent } from '../runtime/events.ts';
import type { NativeAgent } from '../runtime/native/request.ts';
import { SelfCorrection } from '../runtime/native/selfCorrection.ts';
import { runNativeAgent } from '../runtime/nativeTurn.ts';
import { chooseRuntime } from '../runtime/runtimeFlag.ts';
import type { RuntimeName } from '../runtime/runtimeFlag.ts';
import { InProcessSessionService } from '../runtime/sessions.ts';
import { toolOf } from '../tools/tool.ts';

export interface WikiAgentRun {
  name: string;
  description: string;
  model: string;
  instruction: string;
  userText: string;
  tools?: FunctionTool[];
  temperature?: number;
  maxOutputTokens?: number;
  /** The runtime that runs the agent. Default: MELCHIZEDEK_RUNTIME, else native. */
  runtime?: RuntimeName;
  /** Native runtime only: the leaf adapter for a model id. Default resolveAdapter (lib/models/registry.ts). */
  adapterFor?: (model: string) => ModelAdapter;
}

export interface WikiAgentResult {
  text: string;
  error?: string;
}

/** True when the model's provider has credentials (Ollama needs none). */
export function modelAvailable(model: string): { ok: boolean; reason?: string } {
  const provider = providerForModel(model);
  if (provider === 'ollama' || providerKeyPresent(provider)) return { ok: true };
  return { ok: false, reason: `provider "${provider}" has no API key configured` };
}

const APP_NAME = 'melchizedek-wiki';
const USER_ID = 'wiki';

/** The generateContentConfig every wiki run sends. */
function configOf(run: WikiAgentRun): Record<string, unknown> {
  return {
    temperature: run.temperature ?? 0.3,
    maxOutputTokens: run.maxOutputTokens ?? 4096,
  };
}

/** Reads a run's events, either runtime: every non-thinking text part, and the last error. */
async function readRun(stream: () => AsyncIterable<unknown>): Promise<WikiAgentResult> {
  let outputText = '';
  let errorText = '';
  try {
    for await (const event of stream()) {
      const e = event as { errorCode?: string; errorMessage?: string; content?: { parts?: unknown[] } };
      if ((e.errorCode || e.errorMessage) && e.errorCode !== 'STOP') {
        errorText = `[${e.errorCode ?? 'ERROR'}] ${e.errorMessage ?? ''}`;
      }
      for (const part of e.content?.parts ?? []) {
        const p = part as { thought?: boolean; text?: string };
        if (!p.thought && p.text) outputText += p.text;
      }
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
  }

  return {
    text: outputText.trim(),
    ...(errorText ? { error: errorText } : {}),
  };
}

export async function runWikiAgent(run: WikiAgentRun): Promise<WikiAgentResult> {
  const availability = modelAvailable(run.model);
  if (!availability.ok) {
    return { text: '', error: availability.reason };
  }
  const sessionId = randomUUID();
  const newMessage = { role: 'user', parts: [{ text: run.userText }] };

  if (chooseRuntime(run.runtime) === 'native') {
    const agent: NativeAgent = {
      name: run.name,
      description: run.description,
      model: run.model,
      instruction: run.instruction,
      generateContentConfig: configOf(run),
      tools: (run.tools ?? []).map((t) => toolOf(t) ?? t),
    };
    const sessions = new InProcessSessionService();
    await sessions.create({ appName: APP_NAME, userId: USER_ID, sessionId });
    return readRun((): AsyncIterable<TurnEvent> =>
      runNativeAgent({
        agent,
        adapterFor: run.adapterFor ?? ((model) => resolveAdapter(model)),
        sessions,
        appName: APP_NAME,
        userId: USER_ID,
        sessionId,
        userParts: newMessage.parts,
        // As on ADK, where this Runner installs no reflect-and-retry plugins.
        selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
      }),
    );
  }

  const { InMemorySessionService, LlmAgent, Runner } = requireAdk('A wiki agent on the adk runtime (MELCHIZEDEK_RUNTIME=adk)');
  registerAvailableProviders();
  const agent = new LlmAgent({
    name: run.name,
    description: run.description,
    model: run.model,
    instruction: run.instruction,
    generateContentConfig: configOf(run) as never,
    ...(run.tools && run.tools.length > 0 ? { tools: run.tools } : {}),
  });
  const sessionService = new InMemorySessionService();
  const runner = new Runner({ agent, appName: APP_NAME, sessionService });
  await sessionService.createSession({ appName: APP_NAME, userId: USER_ID, sessionId, state: {} });
  return readRun(() => runner.runAsync({ userId: USER_ID, sessionId, newMessage }));
}
