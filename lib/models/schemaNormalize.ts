/**
 * lib/models/schemaNormalize.ts — JSON-Schema dialect bridge.
 *
 * WHY this file exists:
 *   Gemini's Schema type spells JSON-Schema
 *   types in UPPERCASE ('OBJECT', 'STRING', …). Every other provider this
 *   framework routes to (Anthropic, OpenAI, xAI, Ollama's OpenAI-compatible
 *   endpoint) requires standard lowercase JSON-Schema types and rejects the
 *   Gemini spelling — Anthropic, for example, with:
 *     400 invalid_request_error: tools.N.custom.input_schema.type:
 *         Input should be 'object'
 *   A schema that arrives in the Gemini dialect (MCP discovery, an OpenAPI
 *   document, a hand-built tool) is converted once, where the tool enters.
 *   See DOCUMENTATION.md §7.1.
 *
 *   The engine's own model contract (lib/models/contract.ts, ADR 0048) takes
 *   tools in its own shape instead: contractToolDeclaration() builds a
 *   ToolDeclaration from an own Tool (lib/tools/tool.ts), a defineTool
 *   contract or a plain declared object, converting Gemini's dialect once,
 *   where the tool enters, and nativeToolOf() names the server-side tools
 *   that declare nothing.
 *
 *   zodInputJsonSchema() is the one place a zod schema becomes JSON Schema,
 *   for every surface: the declaration and the MCP tools/list entry both
 *   derive from it.
 */

import { z } from 'zod';

import type { JsonSchema, NativeTool, ToolDeclaration } from './contract.ts';
import type { ToolContract } from '../tools/toolContract.ts';
import { isInstructionTool, isTool, nativeToolMarkerOf } from '../tools/tool.ts';

/**
 * Standard JSON Schema for what a caller may send a zod schema: its input
 * side (`io: 'input'`), so a field with a default is optional to the model,
 * as it is to the schema. `$schema` is dropped: it is metadata about the
 * document, noise on the wire.
 */
export function zodInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  // A record's `propertyNames: { type: 'string' }` says only that its keys
  // are strings, which JSON keys always are. Gemini refuses the keyword
  // with a 400 (live, 2026-10-08), so it is left out here, the one source
  // every path reads, and the paths keep declaring the same parameters.
  return mapSchemaNodes(json, (node) => {
    const names = node.propertyNames;
    if (isPlainObject(names) && Object.keys(names).length === 1 && names.type === 'string') delete node.propertyNames;
  }) ?? json;
}

/**
 * Deep-clones a Gemini-style JSON schema, lowercasing every `type` value
 * ('OBJECT' → 'object', ['STRING','NULL'] → ['string','null']) while leaving
 * `description`, `enum`, `required`, `format`, and unknown keywords untouched.
 * Never mutates the input — a Gemini agent may hold the same tool object.
 */
export function toLowercaseJsonSchema(schema: unknown): Record<string, unknown> {
  const result = normalizeNode(schema);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNode);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'type') {
      // `type` may be a string or an array of strings (nullable unions).
      if (typeof value === 'string') {
        out[key] = value.toLowerCase();
      } else if (Array.isArray(value)) {
        out[key] = value.map((v) => (typeof v === 'string' ? v.toLowerCase() : v));
      } else {
        out[key] = value;
      }
    } else if (key === 'enum' || key === 'required') {
      // Value lists, not schema nodes — copy verbatim (enum values are data
      // and must keep their original casing).
      out[key] = Array.isArray(value) ? [...value] : value;
    } else {
      out[key] = normalizeNode(value);
    }
  }
  return out;
}

/**
 * The lowercase schema in the shape OpenAI-style "strict" structured output
 * demands: every object node carries `additionalProperties: false` and lists
 * ALL of its properties as required. Optional fields are expressed by the
 * model emitting a null/empty value, not by omission — that is the strict
 * contract, and it is what makes a judge's rubric fields arrive under the
 * names the harness expects rather than improvised ones.
 */
export function toStrictJsonSchema(schema: unknown): Record<string, unknown> {
  return strictNode(toLowercaseJsonSchema(schema)) as Record<string, unknown>;
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  const type = out.type;
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object')) || isPlainObject(out.properties);
  if (isObject && isPlainObject(out.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties as Record<string, unknown>)) props[k] = strictNode(v);
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items !== undefined) out.items = strictNode(out.items);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ── Tool declarations in the contract's shape (ADR 0048) ─────────────────────

/** Keywords whose value is one schema (`items` may also be a draft-4 tuple of them). */
const SUBSCHEMA_KEYWORDS = new Set([
  'items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties',
  'contains', 'propertyNames', 'not', 'if', 'then', 'else',
]);
/** Keywords whose value is a list of schemas. */
const SUBSCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/** Keywords whose value maps names to schemas. */
const SUBSCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
/** Bounds Gemini's Schema spells as int64 strings (`'1'`); JSON Schema wants integers. */
const INTEGER_KEYWORDS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'] as const;

/**
 * What a declaration built from a zod schema leaves out, as toGeminiSchema
 * leaves it out, so a contract declares the same parameters whichever
 * surface resolves it: the `default` keyword (zod applies
 * defaults at parse time, and the field is already optional), and an
 * `additionalProperties` that is only `true` or `false`. An
 * `additionalProperties` holding a schema, a record's value schema, is kept.
 */
function dropZodOnlyKeywords(node: Record<string, unknown>): void {
  delete node.default;
  if (typeof node.additionalProperties === 'boolean') delete node.additionalProperties;
}

/** A deep copy of a JSON value, so a walk can change it without touching a tool's own schema. */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)]));
  return value;
}

/**
 * Visits every schema node in place, children first. It follows only the
 * keywords that hold schemas, so a property named `type`, `enum` or
 * `default` is a property like any other, and data (`enum`, `const`,
 * `default`, `examples`) is never read as a schema.
 */
function walkSchema(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!isPlainObject(node)) return; // boolean schemas, malformed nodes
  for (const [key, value] of Object.entries(node)) {
    if (SUBSCHEMA_KEYWORDS.has(key)) {
      if (Array.isArray(value)) value.forEach((v) => walkSchema(v, visit));
      else walkSchema(value, visit);
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach((v) => walkSchema(v, visit));
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      Object.values(value).forEach((v) => walkSchema(v, visit));
    }
  }
  visit(node);
}

/**
 * A deep copy of `schema` with `visit` applied to every schema node of the
 * copy, children first, following only the keywords that hold schemas (a
 * property named `default` or `additionalProperties` is a property, not the
 * keyword). Never mutates `schema`. Undefined for a schema that is not an
 * object.
 */
export function mapSchemaNodes(schema: unknown, visit: (node: Record<string, unknown>) => void): Record<string, unknown> | undefined {
  if (!isPlainObject(schema)) return undefined;
  const root = cloneJson(schema) as Record<string, unknown>;
  walkSchema(root, visit);
  return root;
}

/** Keywords that say what a node is about, not what it admits; they stay put when a nullable node is wrapped. */
const ANNOTATION_KEYWORDS = new Set(['title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly', '$defs', 'definitions']);
/** Keywords beside which a type that admits null still refuses it. */
const NULL_REFUSING_KEYWORDS = ['allOf', 'anyOf', 'oneOf', '$ref', 'not', 'const'];

/**
 * One node from Gemini's dialect into lowercase JSON Schema: types
 * lowercased, int64 bounds as integers, the strict form when asked, and
 * OpenAPI's `nullable: true` turned into a schema that admits null. Strict
 * comes before null, because admitting null may move the node's properties
 * into an anyOf branch the walk has already passed. A node already in the
 * standard dialect passes through unchanged.
 */
function toContractNode(node: Record<string, unknown>, fromZod: boolean, strict: boolean): void {
  delete node.$schema;
  if (fromZod) dropZodOnlyKeywords(node);
  if (typeof node.type === 'string') node.type = node.type.toLowerCase();
  else if (Array.isArray(node.type)) node.type = node.type.map((t) => (typeof t === 'string' ? t.toLowerCase() : t));
  for (const key of INTEGER_KEYWORDS) {
    const bound = node[key];
    if (typeof bound === 'string' && /^\d+$/.test(bound)) node[key] = Number(bound);
  }
  if (strict) toStrictNode(node);
  if (typeof node.nullable !== 'boolean') return;
  const nullable = node.nullable;
  delete node.nullable;
  if (nullable) admitNull(node);
}

/**
 * Make `node` admit null. A plain typed node gains `null` in its type (and
 * its enum, which would otherwise refuse it); a bare `anyOf` gains a null
 * branch; anything else ($ref, allOf, oneOf, const…) moves into an anyOf
 * beside `{ type: 'null' }`, its annotations staying on the node.
 */
function admitNull(node: Record<string, unknown>): void {
  const composed = NULL_REFUSING_KEYWORDS.some((k) => k in node);
  if (node.type !== undefined && !composed) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.includes('null')) node.type = typeof node.type === 'string' ? [node.type, 'null'] : [...types, 'null'];
    if (Array.isArray(node.enum) && !node.enum.includes(null)) node.enum = [...node.enum, null];
    return;
  }
  const constraints = Object.keys(node).filter((k) => !ANNOTATION_KEYWORDS.has(k));
  if (constraints.length === 0) return; // an unconstrained schema admits null already
  if (constraints.length === 1 && constraints[0] === 'anyOf' && Array.isArray(node.anyOf)) {
    if (!node.anyOf.some((s) => isPlainObject(s) && s.type === 'null')) node.anyOf = [...node.anyOf, { type: 'null' }];
    return;
  }
  // fromEntries defines each key, so an own `__proto__` from an untrusted
  // (MCP) schema stays a key instead of setting the new object's prototype.
  const inner = Object.fromEntries(constraints.map((key) => [key, node[key]]));
  for (const key of constraints) delete node[key];
  node.anyOf = [inner, { type: 'null' }];
}

/**
 * The strict form of one node: an object with properties lists them all as
 * required and allows no others. An optional property becomes required as
 * it is, not widened to null: a contract's zod schema would refuse the null.
 */
function toStrictNode(node: Record<string, unknown>): void {
  if (!isPlainObject(node.properties)) return;
  node.required = Object.keys(node.properties);
  node.additionalProperties = false;
}

/**
 * A copy of `schema` as lowercase JSON Schema, the contract's one dialect
 * (`JsonSchema`), from either dialect. With `strict`, every object node
 * that has properties, at any depth (inside `items`, `anyOf`, `$defs`, …),
 * lists all of them as required and sets `additionalProperties: false`: the
 * form OpenAI's and Anthropic's strict modes demand. An object without
 * properties (a map) is left open, so a strict provider refuses it instead
 * of receiving a field the model can never fill. Never mutates `schema`.
 */
export function toContractJsonSchema(schema: unknown, options: { strict?: boolean } = {}): JsonSchema {
  return contractSchema(schema, false, options.strict === true);
}

/**
 * The parameters a zod schema declares, in the contract's dialect: its
 * input side (zodInputJsonSchema) without the keywords Gemini's dialect
 * cannot carry (dropZodOnlyKeywords). defineTool's declaration() and
 * contractToolDeclaration() both build from here, so a contract declares the
 * same parameters wherever it is resolved.
 */
export function zodToolParameters(schema: z.ZodType, options: { strict?: boolean } = {}): JsonSchema {
  return contractSchema(zodInputJsonSchema(schema), true, options.strict === true);
}

function contractSchema(schema: unknown, fromZod: boolean, strict: boolean): JsonSchema {
  return mapSchemaNodes(schema, (node) => toContractNode(node, fromZod, strict)) ?? { type: 'object', properties: {} };
}

/** A defineTool contract (lib/tools/toolContract.ts), told apart from an object with runAsync (an ADK tool, which registerTool refuses). */
function isToolContract(tool: Record<string, unknown>): tool is Record<string, unknown> & ToolContract {
  const schema = tool.schema as { safeParse?: unknown } | undefined;
  return !!schema && typeof schema.safeParse === 'function' && typeof tool.execute === 'function' && !('runAsync' in tool);
}

/**
 * The declaration a model receives for one client-side tool, in the
 * contract's shape (ToolDeclaration, lib/models/contract.ts).
 *
 * - An own Tool (lib/tools/tool.ts), defineTool's among them: its own
 *   `declaration()`.
 * - A plain defineTool-shaped contract (name, description, zod schema,
 *   execute): built directly from its zod schema (zodToolParameters), never
 *   through Gemini's uppercase dialect. The input side is declared, so a
 *   field with a default is optional; the `default` keyword and a boolean
 *   `additionalProperties` are left out, as toGeminiSchema leaves them out,
 *   and a record's value schema is kept.
 * - An object with its own `_getDeclaration()` (ADR 0019; the genai
 *   mapping's declared tools): read from it, `parameters` or else
 *   `parametersJsonSchema`, and converted from Gemini's dialect once, here.
 * - A plain object with `name` and `parameters` (tests, hand-built tools).
 *
 * With `strict`, the parameters take the strict form (toContractJsonSchema)
 * and the declaration carries `strict: true`. Returns undefined for a tool
 * that declares nothing (a server-side tool: see nativeToolOf, or an
 * InstructionTool such as `preload_memory`, which only writes into the
 * instruction) and for one with no name.
 */
export function contractToolDeclaration(tool: unknown, options: { strict?: boolean } = {}): ToolDeclaration | undefined {
  if (!isPlainObject(tool) || isInstructionTool(tool) || nativeToolMarkerOf(tool)) return undefined;
  const strict = options.strict === true;
  let name: unknown;
  let description: unknown;
  let parameters: JsonSchema;
  if (isTool(tool)) {
    const decl = tool.declaration();
    name = decl.name;
    description = decl.description;
    parameters = contractSchema(decl.parameters, false, strict);
  } else if (isToolContract(tool)) {
    name = tool.name;
    description = tool.description;
    parameters = zodToolParameters(tool.schema, { strict });
  } else {
    let decl: Record<string, unknown> | undefined;
    if (typeof tool._getDeclaration === 'function') {
      try {
        decl = (tool._getDeclaration as () => Record<string, unknown> | undefined)() ?? undefined;
      } catch {
        decl = undefined;
      }
      // A tool that implements _getDeclaration and returns nothing declares nothing.
      if (!decl) return undefined;
    }
    name = decl ? decl.name ?? tool.name : tool.name;
    description = decl ? decl.description ?? tool.description : tool.description;
    const declared = decl ? decl.parameters ?? decl.parametersJsonSchema : tool.parameters;
    parameters = contractSchema(declared, false, strict);
  }
  if (!name || typeof name !== 'string') return undefined;
  return {
    name,
    description: typeof description === 'string' ? description : '',
    parameters,
    ...(strict ? { strict: true } : {}),
  };
}

/**
 * The NativeTool a tool object stands for, or undefined for any other tool.
 * Recognised by marker, never by class or by shape: the engine's own marker
 * (lib/tools/tool.ts, NATIVE_TOOL) on a NativeToolMarker
 * (lib/tools/nativeTools.ts). The marker lives in the global symbol
 * registry, so a second copy of a module still matches (ADR 0062).
 * A client-side tool registered under one of those names carries no marker,
 * so it stays a client-side tool, as does a tool that merely declares
 * nothing. Any other object is undefined here and declares nothing, so a
 * caller building a request reports it as dropped.
 */
export function nativeToolOf(tool: unknown): NativeTool | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  return nativeToolMarkerOf(tool);
}
