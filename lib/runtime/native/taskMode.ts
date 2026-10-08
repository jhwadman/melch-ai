/**
 * lib/runtime/native/taskMode.ts — `mode: task` on the native loop: the
 * finish_task tool, and how a task-mode node's run ends (ADR 0033, ADR 0081).
 *
 * WHY this file exists:
 *   On the ADK runtime `mode: task` is three things in ADK 2.2: LlmAgent
 *   adds its FinishTaskTool after the agent's own tools and never sets the
 *   output schema as the response schema; the tool declares the output
 *   schema as its parameters, adds a line to the instruction and answers
 *   "Task completed." (or an error naming the missing required keys); and
 *   a workflow node in task mode (ADK's runTaskMode) ends its run on that
 *   answer, the finish_task arguments its output. This file is those three
 *   for the native loop, word for word, so a session either runtime wrote
 *   holds the same events (tests/execution.test.ts).
 *
 * WHERE IT PLUGS IN:
 *   - lib/runtime/native/request.ts adds finishTaskTool(agent.outputSchema)
 *     after the agent's tools and before the caller's extra tools, as
 *     LlmAgent adds it after its own and before a plugin's;
 *   - lib/runtime/native/agentLoop.ts, when its context says the run is a
 *     task-mode node (`taskNode`), passes each event through
 *     taskNodeRun's `beforeStore` and ends the run when `output` is set.
 *   In a plain run (not a node) the loop goes on after finish_task's
 *   answer, as LlmAgent.runAsync does; the schema allows `mode: task` on
 *   workflow nodes only, so a validated syndicate never does that.
 *
 * QUIRKS KEPT FOR PARITY: the arguments are wrapped under `result` unless
 * the schema's type is Gemini's `OBJECT` (ADK compares to Type.OBJECT, so a
 * lowercase `object` is wrapped too), and only top-level `required` keys
 * are checked. The arguments are the model's output: data, read by the next
 * node, never instructions.
 */

import type { ToolDeclaration } from '../../models/contract.ts';
import { toContractJsonSchema } from '../../models/schemaNormalize.ts';
import type { Tool } from '../../tools/tool.ts';
import { getFunctionCalls, getFunctionResponses } from '../events.ts';
import type { TurnEvent } from '../events.ts';
import type { NativeAgent } from './request.ts';

/** ADK's FINISH_TASK_TOOL_NAME. */
export const FINISH_TASK_TOOL_NAME = 'finish_task';
/** ADK's FINISH_TASK_SUCCESS_RESULT: the tool's answer when the arguments carry every required key. */
export const FINISH_TASK_SUCCESS_RESULT = 'Task completed.';

const DESCRIPTION = 'Signal that this agent has completed its delegated task. Call this when you have finished your delegated task.';
const DESCRIPTION_WITH_SCHEMA = `${DESCRIPTION} Pass the required output data in the parameters.`;
/** The line FinishTaskTool.processLlmRequest appends to the instruction. */
export const FINISH_TASK_INSTRUCTION =
  'Do NOT call `finish_task` prematurely. Use your available tools to fully complete every aspect of the task first. If the task is unclear, ask the user for clarification before proceeding. Once the task is fully complete, call `finish_task` by itself with no accompanying text output.';

/** ADK's DEFAULT_TASK_OUTPUT_SCHEMA, for an agent with no output schema. */
const DEFAULT_TASK_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: { result: { type: 'STRING', description: 'A brief summary of what the agent accomplished.' } },
  required: ['result'],
};

/** The key the arguments are wrapped under, or undefined when the schema is Gemini's OBJECT (ADK's wrapperKey). */
function wrapperKeyOf(schema: Record<string, unknown>): string | undefined {
  return schema.type === 'OBJECT' ? undefined : 'result';
}

/** The required keys `value` lacks, as FinishTaskTool.missingRequiredKeys reads them. */
function missingRequiredKeys(schema: Record<string, unknown>, wrapperKey: string | undefined, value: unknown): string[] {
  if (wrapperKey) return value === undefined || value === null ? [wrapperKey] : [];
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  if (typeof value !== 'object' || value === null) return required;
  return required.filter((key) => (value as Record<string, unknown>)[key] === undefined);
}

/** A finish_task own Tool, with the extractor a task-mode node reads its output through. */
export interface FinishTaskTool extends Tool {
  /** The node's output from a finish_task call's arguments: unwrapped from `result` when the schema is not an OBJECT. */
  extractOutput(args: Record<string, unknown>): unknown;
}

/** ADK's FinishTaskTool for an agent's output schema, as an own Tool the native loop declares and runs. */
export function finishTaskTool(outputSchema?: Record<string, unknown>): FinishTaskTool {
  const schema = outputSchema ?? DEFAULT_TASK_OUTPUT_SCHEMA;
  const wrapperKey = wrapperKeyOf(schema);
  const description = outputSchema ? DESCRIPTION_WITH_SCHEMA : DESCRIPTION;
  const parameters = wrapperKey ? { type: 'OBJECT', properties: { [wrapperKey]: schema }, required: [wrapperKey] } : schema;
  return {
    name: FINISH_TASK_TOOL_NAME,
    declaration: (): ToolDeclaration => ({ name: FINISH_TASK_TOOL_NAME, description, parameters: toContractJsonSchema(parameters) }),
    instruction: async () => FINISH_TASK_INSTRUCTION,
    execute: async (args) => {
      const value = wrapperKey ? args[wrapperKey] : args;
      const missing = missingRequiredKeys(schema, wrapperKey, value);
      if (missing.length > 0) {
        return {
          error: `Invoking \`${FINISH_TASK_TOOL_NAME}()\` failed due to missing required parameters: ${missing.join(', ')}. You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters with correct types.`,
        };
      }
      return FINISH_TASK_SUCCESS_RESULT;
    },
    extractOutput: (args) => (wrapperKey ? args[wrapperKey] : args),
  };
}

/** One task-mode node's run: what the loop's task hook reads (ADK's runTaskMode). */
export interface TaskNodeRun {
  /** Called on each event before it is stored: notes a finish_task call, and marks its successful answer as the node's output. */
  beforeStore(event: TurnEvent): void;
  /** True once finish_task answered with success: the run ends after that event is stored. */
  readonly finished: boolean;
  /** The node's output: the finish_task arguments, extracted. */
  readonly output: unknown;
}

function isSuccess(event: TurnEvent): boolean {
  return getFunctionResponses(event).some(
    (r) => r.name === FINISH_TASK_TOOL_NAME && ((r.response ?? {}) as Record<string, unknown>).result === FINISH_TASK_SUCCESS_RESULT,
  );
}

/**
 * The task hook for a node run of `agent`: the latest finish_task call's
 * arguments are held; the event that answers it with success gets
 * `output` (the extracted arguments), `nodeInfo.messageAsOutput`, and the
 * output under the agent's outputKey in its stateDelta, before it is stored.
 */
export function taskNodeRun(agent: Pick<NativeAgent, 'outputSchema' | 'outputKey'>): TaskNodeRun {
  const tool = finishTaskTool(agent.outputSchema);
  let pendingArgs: Record<string, unknown> | undefined;
  let finished = false;
  let output: unknown;
  return {
    beforeStore(event) {
      if (finished || event.partial) return;
      const call = getFunctionCalls(event).find((c) => c.name === FINISH_TASK_TOOL_NAME);
      if (call) {
        pendingArgs = { ...(call.args ?? {}) };
        return;
      }
      if (pendingArgs === undefined || !isSuccess(event)) return;
      output = tool.extractOutput(pendingArgs);
      event.output = output;
      event.nodeInfo = { ...(event.nodeInfo ?? {}), messageAsOutput: true };
      if (agent.outputKey && output !== undefined) {
        const delta = (event.actions.stateDelta ??= {}) as Record<string, unknown>;
        Object.defineProperty(delta, agent.outputKey, { value: output, writable: true, enumerable: true, configurable: true });
      }
      finished = true;
    },
    get finished() {
      return finished;
    },
    get output() {
      return output;
    },
  };
}
