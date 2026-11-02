/**
 * lib/runtime/native/recall.ts — `recall_tool_result`: reading a masked tool
 * result back (ADR 0152).
 *
 * WHY this file exists:
 *   The history projection (lib/runtime/native/history.ts) sends an old
 *   tool result as a stub, `{ masked: true, ref, … }`. Nothing leaves the
 *   projection without a way back: this tool takes the stub's `ref` (the
 *   stored event's id) and returns the stored result, cut to the shared
 *   tool-result limit. It is made per request, closed over that session's
 *   events and the agent's history scope, so it reads this session only,
 *   and only an event this agent's own projection would include; any other
 *   ref is "no such result". It touches no network and no file.
 *
 *   The request builder lists it only on a request whose projection masked
 *   something, with a one-line note in the system prompt: the note is the
 *   same words every time, so the prefix changes once, when masking starts.
 */
import { z } from 'zod';

import type { TurnEvent } from '../events.ts';
import { capResult, MAX_RESULT_CHARS } from '../../tools/tool.ts';
import type { Tool } from '../../tools/tool.ts';
import { defineTool } from '../../tools/toolContract.ts';
import { storedToolResult } from './history.ts';
import type { HistoryScope } from './history.ts';

export const RECALL_TOOL = 'recall_tool_result';

/** What the system prompt says when results are masked. The same words every request. */
export const RECALL_NOTE =
  'Some earlier tool results in this conversation are shown as {"masked": true, "ref": …} stubs with their first characters. '
  + `Call ${RECALL_TOOL} with a stub's ref when you need that result in full.`;

export const NO_SUCH_RESULT = 'No such result.';

/** The tool for one request: it reads `events` as `scope` sees them. */
export function recallToolResultTool(events: readonly TurnEvent[], scope: HistoryScope): Tool {
  return defineTool({
    name: RECALL_TOOL,
    description: 'Read an earlier tool result that was shown as a masked stub, by the stub\'s ref.',
    schema: z.object({ ref: z.string().min(1).describe('The ref from the masked stub.') }),
    maxResultChars: MAX_RESULT_CHARS,
    execute: async ({ ref }) => {
      const found = storedToolResult(events, ref, scope);
      if (!found) return { error: NO_SUCH_RESULT };
      return { tool: found.tool, result: capResult(found.response) };
    },
  });
}
