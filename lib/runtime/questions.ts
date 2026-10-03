/**
 * lib/runtime/questions.ts — an agent asks the person a question mid-turn,
 * and the next message is the answer.
 *
 * WHY: A syndicate that is put in front of users needs to ask: "which of
 * these three accounts?", "what is the order number?". Before this, an
 * agent could only end its turn with a question in its text and hope the
 * next message answered it, with nothing in the session saying a question
 * was open. `ask_user` is ADK's long-running tool mechanism under one YAML
 * name: the call is recorded, the run ends without a response to it, the
 * turn ends `input-required` (`result.input`), and the next message on the
 * conversation becomes the call's response, so the agent resumes its own
 * tool loop where it asked, with the question and the answer side by side
 * in its history.
 *
 * The same `input-required` path carries a workflow's `ask_user` node
 * (lib/workflow.ts) and an approval (ADR 0028); a client handles all three
 * by showing `result.input` (or the approval) and sending the next message.
 *
 * WHERE: only on an agent the turn runs directly (the orchestrator, or a
 * plan-dispatch route), as with approval gates: inside a delegated
 * subagent ADK swallows the pause. Not inside a workflow node yet. The
 * schema refuses both.
 */
import { LongRunningFunctionTool } from '@google/adk';
import type { Event } from '@google/adk';
import { z } from 'zod';

import type { PendingInput } from '../workflowConfig.ts';

/** The registry name, and the function-call name an open question carries. */
export const ASK_USER = 'ask_user';

export const MAX_OPTIONS = 10;

/**
 * The tool. Its execute returns nothing: a long-running call with no result
 * ends the run, and ADK waits for a function response with the call's id.
 */
export const askUserTool = new LongRunningFunctionTool({
  name: ASK_USER,
  description:
    'Ask the person one question and wait for their answer before you continue: a missing detail you need, or a choice only they can make. ' +
    'Pass `options` when the answer is one of a few choices. The turn ends here; the person\'s next message is the answer, returned to you as this call\'s result. ' +
    'Ask only what you cannot find out or reasonably assume, one question per call.',
  parameters: z.object({
    question: z.string().min(1).max(500).describe('The question, as the person will read it.'),
    options: z
      .array(z.string().min(1).max(120))
      .max(MAX_OPTIONS)
      .optional()
      .describe('The choices, when the answer is one of a few. Omit for a free answer.'),
  }),
  execute: async (_args, context) => {
    if (context) (context.actions as { skipSummarization?: boolean }).skipSummarization = true;
    return null;
  },
});

const partsOf = (e: Event) => (e.content?.parts ?? []) as Array<Record<string, any>>;
const hasUserText = (e: Event) => e.author === 'user' && partsOf(e).some((p) => typeof p.text === 'string' && p.text.trim() && !p.thought);

/** The question an `ask_user` call carries, as the turn result reports it. */
export function questionFrom(author: string | undefined, call: { name?: string; id?: string; args?: Record<string, unknown> }): PendingInput | undefined {
  if (call.name !== ASK_USER || !call.id) return undefined;
  const args = call.args ?? {};
  const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === 'string') : [];
  return {
    id: call.id,
    node: author ?? '',
    message: typeof args.question === 'string' ? args.question : '',
    ...(options.length ? { payload: { options } } : {}),
  };
}

/**
 * The question still waiting for an answer in a session, or undefined. A
 * question the person moved past (a text message after it was answered)
 * is not pending; an answered one carries a function response with its id.
 */
export function pendingQuestion(events: readonly Event[]): PendingInput | undefined {
  const answered = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (hasUserText(e)) return undefined;
    for (const p of partsOf(e)) {
      if (p.functionResponse?.name === ASK_USER && p.functionResponse.id) answered.add(p.functionResponse.id);
    }
    for (const p of partsOf(e)) {
      const call = p.functionCall;
      if (call?.name !== ASK_USER || !call.id || answered.has(call.id)) continue;
      return questionFrom(e.author, call);
    }
  }
  return undefined;
}

/** The message part that answers question `id` with the person's text. */
export function questionAnswerPart(id: string, answer: string): Record<string, unknown> {
  return { functionResponse: { id, name: ASK_USER, response: { result: answer } } };
}

/** Index of the user message that started the turn holding call `id` (replayed raw on a dispatch resume). */
export function turnStartOfCall(events: readonly Event[], id: string): number {
  let callAt = -1;
  for (let i = events.length - 1; i >= 0 && callAt === -1; i--) {
    if (partsOf(events[i]!).some((p) => p.functionCall?.id === id)) callAt = i;
  }
  for (let i = callAt; i >= 0; i--) if (hasUserText(events[i]!)) return i;
  return Math.max(0, callAt);
}
