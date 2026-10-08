/**
 * lib/tools/memoryTools.ts — long-term memory's two tools, as the engine's
 * own (ADR 0020, ADR 0051, ADR 0059).
 *
 * WHY this file exists:
 *   A syndicate with `memory_system: long-term` reaches its memory through
 *   two YAML tool names. Both were ADK's own objects (LOAD_MEMORY and
 *   PRELOAD_MEMORY), which only ADK's loop can run. Here they are the
 *   engine's, so the native runtime runs them, and the ADK runtime runs the
 *   same objects through lib/tools/adkTool.ts:
 *
 *     load_memory     a Tool the model calls with a query. It returns the
 *                     facts recalled for it, and while the run has memory it
 *                     adds a note to the instruction saying memory exists.
 *     preload_memory  an InstructionTool the model never calls. Before each
 *                     request it recalls facts for the message that started
 *                     the run and writes them into the instruction.
 *
 * WORD FOR WORD: the declaration, the note, the result's shape and the
 * recalled block are what ADK's LoadMemoryTool and PreloadMemoryTool
 * produced, so a model reads the same request on either runtime
 * (tests/memoryTools.test.ts compares them with ADK's own tools).
 *
 * WHOSE MEMORY: both search through the context's `searchMemory`, which is
 * bound to the run's own `<appName>/<userId>` silo; a query can choose what
 * to recall, never whose. The runtime pins `appName` to the root syndicate's
 * namespace (namespacedMemoryService, lib/memory/namespace.ts).
 *
 * Recalled facts are data the user's own conversations produced, never
 * instructions: preload_memory fences them in a <PAST_CONVERSATIONS> block.
 *
 * No ADK here: nothing this module loads at runtime names @google/*.
 */

import { z } from 'zod';

import type { MemoryEntry } from '../runtime/memoryService.ts';
import { defineTool } from './toolContract.ts';
import type { InstructionTool, ToolContext } from './tool.ts';

/** ADK's LoadMemoryTool note, word for word, line break included. */
export const LOAD_MEMORY_INSTRUCTION = `You have memory. You can use it to answer questions. If any questions need
you to look up the memory, you should call load_memory function with a query.`;

/** What load_memory and ADK's LoadMemoryTool say when the run has no memory service. */
export const NO_MEMORY_SERVICE = 'Memory service is not initialized.';

/** A memory's text: its parts' texts joined by a space, a part without text counting as empty, as ADK joins them. */
export function memoryText(memory: MemoryEntry): string {
  return memory.content.parts?.map((p) => p.text ?? '').join(' ') ?? '';
}

/** One recalled memory as load_memory returns it. */
export interface LoadedMemory {
  content: string;
  author?: string;
  timestamp?: string;
}

export const loadMemoryTool = defineTool({
  name: 'load_memory',
  description: 'Loads the memory for the current user.\n\nNOTE: Currently this tool only uses text part from the memory.',
  schema: z.object({
    query: z.string().describe('The query to load the memory for.'),
  }),
  async execute({ query }, ctx): Promise<{ memories: LoadedMemory[] }> {
    if (!ctx.searchMemory) throw new Error(NO_MEMORY_SERVICE);
    try {
      const { memories } = await ctx.searchMemory(query);
      return {
        memories: memories.map((m) => ({ content: memoryText(m), author: m.author, timestamp: m.timestamp })),
      };
    } catch (err: unknown) {
      // A failed search is the call's error, reported to the model by the
      // runtime. The query is the user's words, so it is not logged.
      console.error('[load_memory] Memory search failed:', err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
  // Only while the run has memory: a syndicate without it is not told it has some.
  instruction: async (ctx) => (ctx.searchMemory ? LOAD_MEMORY_INSTRUCTION : undefined),
});

/**
 * The block preload_memory writes for the recalled memories, word for word
 * ADK's PreloadMemoryTool's: each memory's time on its own line when it has
 * one, then its text, prefixed by its author when it has one. Undefined when
 * no memory has text.
 */
export function preloadMemoryInstruction(memories: MemoryEntry[]): string | undefined {
  const lines: string[] = [];
  for (const memory of memories) {
    if (memory.timestamp) lines.push(`Time: ${memory.timestamp}`);
    const text = memoryText(memory);
    if (text) lines.push(memory.author ? `${memory.author}: ${text}` : text);
  }
  if (lines.length === 0) return undefined;
  return `The following content is from your previous conversations with the user.
They may be useful for answering the user's current query.
<PAST_CONVERSATIONS>
${lines.join('\n')}
</PAST_CONVERSATIONS>
`;
}

export const preloadMemoryTool: InstructionTool = {
  name: 'preload_memory',
  /**
   * The facts recalled for the first text part of the message that started
   * the run. Nothing when that part has no text, the run has no memory,
   * nothing is recalled, or the search fails: a failed recall never fails
   * the request.
   */
  async instruction(ctx: ToolContext): Promise<string | undefined> {
    const query = ctx.userContent?.parts?.[0]?.text;
    if (!query || !ctx.searchMemory) return undefined;
    let memories: MemoryEntry[];
    try {
      ({ memories } = await ctx.searchMemory(query));
    } catch (err: unknown) {
      // ADK logged the query here; it is the user's words, so this does not.
      console.warn('[preload_memory] Memory search failed; the request goes without recalled facts:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
    if (!memories || memories.length === 0) return undefined;
    return preloadMemoryInstruction(memories);
  },
};
