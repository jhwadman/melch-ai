/**
 * lib/tools/examples.ts — an agent's `examples:` as an instruction block
 * (ADR 0059, ADR 0062).
 *
 * WHY this file exists:
 *   A YAML agent's `examples:` lists exchanges the model should imitate. ADK's
 *   ExampleTool wrote them into the system instruction of each request as a
 *   few-shot block, and the native loop writes the same block.
 *   Writing into the instruction is what an InstructionTool does
 *   (lib/tools/tool.ts), so the examples are one: it declares no function,
 *   is never called, and adds the block, word for word as ExampleTool
 *   formatted it, before each request, where ExampleTool appended it.
 *
 *   As with ExampleTool, the block is added only when the message that
 *   started the run begins with text. YAML examples are text alone, so the
 *   function-call renderings ExampleTool also had never apply.
 *
 * The examples are the agent author's prompt text, not the user's words.
 * A LEAF: nothing in its import graph names @google/*.
 */

import type { InstructionTool, ToolContext } from './tool.ts';

/** An agent's `examples:` entry: one exchange the model should imitate. */
export interface ExampleConfig {
  input: string;
  output: string;
}

/** The name ADK's ExampleTool carried, which the instruction block keeps. */
export const EXAMPLES_TOOL_NAME = 'example_tool';

// ExampleTool's strings (ADK's examples/example_util.js), kept word for word.
const EXAMPLES_INTRO =
  '<EXAMPLES>\nBegin few-shot\nThe following are examples of user queries and model responses using the available tools.\n\n';
const EXAMPLES_END = 'End few-shot\n<EXAMPLES>';
const EXAMPLE_END = 'End example\n\n';
const USER_PREFIX = '[user]\n';
const MODEL_PREFIX = '[model]\n';

/**
 * The few-shot block for `examples`, as ExampleTool rendered text-only
 * examples: each numbered, the user's text then the model's, each line
 * ending in a newline. An empty input or output keeps its role line and
 * adds no text, as ExampleTool did.
 */
export function examplesInstruction(examples: readonly ExampleConfig[]): string {
  let body = '';
  examples.forEach((example, i) => {
    body += `EXAMPLE ${i + 1}:\nBegin example\n${USER_PREFIX}`;
    body += `${example.input ? example.input : ''}\n`;
    body += MODEL_PREFIX;
    if (example.output) body += `${example.output}\n`;
    body += EXAMPLE_END;
  });
  return `${EXAMPLES_INTRO}${body}${EXAMPLES_END}`;
}

/**
 * An agent's examples as an InstructionTool, or undefined when it has none.
 * It adds the block when the run's first message begins with text, as
 * ExampleTool did, and nothing otherwise.
 */
export function examplesInstructionTool(examples: readonly ExampleConfig[] | undefined): InstructionTool | undefined {
  if (!examples?.length) return undefined;
  const text = examplesInstruction(examples);
  return {
    name: EXAMPLES_TOOL_NAME,
    instruction: async (ctx: ToolContext) => (ctx.userContent?.parts?.[0]?.text ? text : undefined),
  };
}
