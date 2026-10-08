/**
 * lib/runtime/valueDepth.ts — how deeply a JSON value nests, read without
 * recursion (WS5-5, ADR 0101).
 *
 * WHY this file exists:
 *   A tool call's arguments come from a model, and a tool's result can come
 *   from a remote server (an MCP tool, a fetched API). Both are stored in the
 *   session and read again on every later step: cloned for the history,
 *   serialized for a durable store and a span. Those readers recurse, so a
 *   value nested a few thousand levels deep overflows the stack in each of
 *   them, on this turn and on every turn after it: the session stops
 *   working. No tool schema the engine knows nests anywhere near
 *   MAX_VALUE_DEPTH, so a value past it is malformed, and the runtime keeps
 *   a short note in its place (lib/models/genaiMapping.ts contractOutputPart for
 *   arguments, lib/runtime/native/agentLoop.ts for results).
 *
 *   The check itself walks with an explicit stack, so the value it guards
 *   against cannot overflow it.
 */

/** The deepest a tool call's arguments or a tool's result may nest, in levels of objects and arrays (the value itself is level 1). */
export const MAX_VALUE_DEPTH = 64;

/** True when `value` nests objects or arrays more than `max` levels deep. Iterative; a value seen twice (a cycle) is walked once. */
export function nestedDeeperThan(value: unknown, max: number = MAX_VALUE_DEPTH): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const stack: Array<{ node: object; level: number }> = [{ node: value, level: 1 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { node, level } = stack.pop() as { node: object; level: number };
    if (level > max) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const child of Object.values(node)) {
      if (typeof child === 'object' && child !== null) stack.push({ node: child, level: level + 1 });
    }
  }
  return false;
}
