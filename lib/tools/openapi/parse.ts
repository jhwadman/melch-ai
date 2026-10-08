/**
 * lib/tools/openapi/parse.ts — an OpenAPI 3 spec, read into the engine's own
 * types: one operation per path and method, each with the parameters a call
 * fills and the ToolDeclaration the model receives (ADR 0045, ADR 0063).
 *
 * WHY this file exists:
 *   The `openapi:` key (ADR 0032) handed the spec to ADK's OpenAPIToolset,
 *   which parsed it, named the tools and declared them in Gemini's dialect.
 *   The native runtime owns its tools (ADR 0051), so it owns this step too.
 *   This parser reproduces ADK 2.2's rules exactly, so an agent's tools keep
 *   their names, their arguments and the declaration a model reads:
 *
 *   - `$ref`s inside the document are resolved in document order, a ref met
 *     again while it is still being resolved (a cycle) becoming its sibling
 *     keys without the `$ref`, and an unresolvable one staying as written.
 *     An external ref (`other.yaml#/…`) fails the parse.
 *   - Inside a schema, a `type` is lowercased; one that is not a JSON Schema
 *     type is dropped, and a list keeps its valid entries.
 *   - Operations come in path order, then get, post, put, delete, patch,
 *     head, options, trace. An operation without an operationId is named
 *     from its path and method (`/pets/{petId}` get → `pets_pet_id_get`).
 *   - A tool's name is its operationId in snake_case, a Python keyword
 *     prefixed `param_`, cut at 60 characters, behind `<prefix>_` when the
 *     entry sets one, and the whole cut at 60 again.
 *   - Arguments: the operation's parameters, then the path's; then the
 *     request body's first media type: an object's properties one argument
 *     each, any other body one argument named `body`. Names are snake_case,
 *     and a repeated name gains `_1`, `_2`.
 *   - The declaration carries each argument's schema (a query parameter's
 *     own `description` is not part of it), filtered to the keywords
 *     Gemini's schema has, `title`, `default` and `format` left out. A node
 *     without a type is an object, and an object without properties gets
 *     the placeholder property ADK gives it.
 *
 * BOUNDED: a spec is configuration a person reviews, but it is still input.
 *   A file over MAX_SPEC_BYTES is refused before it is read; YAML aliases
 *   are capped; resolving refs counts every value it produces and stops at
 *   MAX_SPEC_NODES (a ref used twice is copied twice, so a small file could
 *   otherwise expand exponentially); nesting deeper than MAX_SPEC_DEPTH is
 *   refused; a ref cycle ends where it closes. Every failure is an Error
 *   with a readable message, which fails the compile.
 *
 * A LEAF: no ADK, no network, no environment. The caller (the HTTP call,
 * the SSRF guard, credentials) stays in lib/tools/openapiTools.ts.
 */

import { parse as parseYaml } from 'yaml';

import type { JsonSchema, ToolDeclaration } from '../../models/contract.ts';
import { toContractJsonSchema } from '../../models/schemaNormalize.ts';

// ── Limits ──────────────────────────────────────────────────────────────────

/** The largest spec file read, in bytes. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
/** The most values (objects, arrays and scalars) a spec may hold once its refs are resolved. */
export const MAX_SPEC_NODES = 1_000_000;
/** The deepest nesting of objects and arrays a spec may have, refs resolved. */
export const MAX_SPEC_DEPTH = 128;
/** The most YAML aliases resolved in one spec. */
export const MAX_YAML_ALIASES = 100;
/** The longest tool name (ADK's RestApiTool cut). */
export const MAX_TOOL_NAME = 60;

// ── Types ───────────────────────────────────────────────────────────────────

/** Where an argument goes in the request. */
export type OpenApiParameterLocation = 'path' | 'query' | 'header' | 'cookie' | 'body' | (string & {});

/** One argument of an operation: what the model fills and where the call puts it. */
export interface OpenApiParameter {
  /** The argument's name as the model sees it (snake_case, deduplicated). */
  name: string;
  /** The name in the request: a query key, a header, a path placeholder, a body property. `body`, `array` or '' for a whole body. */
  originalName: string;
  location: OpenApiParameterLocation;
  /** The parameter's schema as the spec gives it, refs resolved. */
  schema: Record<string, unknown>;
  description?: string;
  required: boolean;
}

/** One operation of a spec, read. */
export interface OpenApiOperation {
  /** The tool name: `<prefix>_<snake operationId>`, at most 60 characters. */
  name: string;
  /** The spec's operationId, or the one made from the path and method. */
  operationId: string;
  /** Lowercase HTTP method. */
  method: string;
  /** The path template, e.g. `/pets/{petId}`. */
  path: string;
  /** The first server's URL, its variables filled from their defaults; '' when the spec names none. */
  baseUrl: string;
  /** The operation's description, else its summary: the tool's prompt. */
  description: string;
  parameters: OpenApiParameter[];
  /** What the model receives for this tool. */
  declaration: ToolDeclaration;
  /** The operation object, refs resolved, its parameters merged with the path's. */
  operation: Record<string, unknown>;
  /** The security scheme its first requirement (or the spec's) names, when the spec defines it. */
  authScheme?: Record<string, unknown>;
}

export interface ParseOptions {
  /** Prepended to every tool name as `<prefix>_`. */
  prefix?: string;
  /** Names the spec in error messages. */
  source?: string;
}

// ── Names ───────────────────────────────────────────────────────────────────

const isUpper = (c: string) => c >= 'A' && c <= 'Z';
const isLower = (c: string) => c >= 'a' && c <= 'z';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlnum = (c: string) => isUpper(c) || isLower(c) || isDigit(c);

/**
 * snake_case the way the engine matches a configured operation name
 * (namesTool): `_` between a lowercase letter or digit and a capital, every
 * run of other characters one `_`, none at either end, lowercased. A single
 * pass, so its time is linear in the input.
 */
export function toSnake(name: string): string {
  let out = '';
  let pendingSep = false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (!isAlnum(c)) {
      pendingSep = true;
      continue;
    }
    const prev = i > 0 ? name[i - 1]! : '';
    if (pendingSep || (isUpper(c) && (isLower(prev) || isDigit(prev)))) {
      if (out.length > 0) out += '_';
      pendingSep = false;
    }
    out += c;
  }
  return out.toLowerCase();
}

/**
 * snake_case the way ADK 2.2 names a tool and an argument (its
 * toSnakeCaseName): as toSnake, and also `_` before the last capital of a
 * run of two or more that a lowercase letter follows (`HTTPStatus` →
 * `http_status`). A single pass, so its time is linear in the input.
 */
export function adkSnake(name: string): string {
  let out = '';
  let pendingSep = false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (!isAlnum(c)) {
      pendingSep = true;
      continue;
    }
    const prev = i > 0 ? name[i - 1]! : '';
    const next = i + 1 < name.length ? name[i + 1]! : '';
    const camelBreak = isUpper(c) && (isLower(prev) || isDigit(prev));
    // The last capital of a run of two or more, followed by a lowercase letter.
    const acronymBreak = isUpper(c) && isUpper(prev) && isLower(next);
    if (pendingSep || camelBreak || acronymBreak) {
      if (out.length > 0) out += '_';
      pendingSep = false;
    }
    out += c;
  }
  return out.toLowerCase();
}

/** Python's keywords, which ADK prefixes with `param_` in a name. */
const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/** An argument or tool name made from a spec's name. */
export function argumentName(original: string): string {
  const snake = adkSnake(original);
  return RESERVED.has(snake) ? `param_${snake}` : snake;
}

/** True when a configured operation name (an operationId or a tool name) names this tool. */
export function namesTool(configured: string, tool: { name: string; operation?: { operationId?: string } }): boolean {
  return configured === tool.name || configured === tool.operation?.operationId || toSnake(configured) === tool.name;
}

/**
 * True when an `operations:` entry names this operation: by operationId, by
 * tool name with or without the entry's prefix, or by either in snake_case.
 */
export function operationNamed(configured: string, op: Pick<OpenApiOperation, 'name' | 'operationId'>, prefix?: string): boolean {
  const operation = { operationId: op.operationId };
  if (namesTool(configured, { name: op.name, operation })) return true;
  const bare = prefix && op.name.startsWith(`${prefix}_`) ? op.name.slice(prefix.length + 1) : op.name;
  return namesTool(configured, { name: bare, operation });
}

// ── Reading the file ────────────────────────────────────────────────────────

function fail(source: string | undefined, message: string): never {
  throw new Error(source ? `openapi ${source}: ${message}` : `openapi: ${message}`);
}

/**
 * The document a spec's text holds. YAML is read with the package's own
 * reader, with timestamps and merge keys as ADK's reader had them, and at
 * most MAX_YAML_ALIASES aliases.
 */
export function readSpecText(text: string, format: 'json' | 'yaml', source?: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_SPEC_BYTES) fail(source, `the spec is larger than ${MAX_SPEC_BYTES} bytes`);
  try {
    if (format === 'json') return JSON.parse(text);
    return parseYaml(text, { merge: true, customTags: ['timestamp'], maxAliasCount: MAX_YAML_ALIASES });
  } catch (err) {
    if (err instanceof RangeError) fail(source, 'the spec is nested too deeply to read');
    fail(source, `the spec is not valid ${format === 'json' ? 'JSON' : 'YAML'}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// ── Bounded copying and ref resolution ──────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sets an own property, so a key named `__proto__` stays a key. */
function put(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Counts values against MAX_SPEC_NODES and nesting against MAX_SPEC_DEPTH. */
class Budget {
  private nodes = 0;
  private readonly source?: string;
  constructor(source?: string) {
    this.source = source;
  }
  spend(depth: number): void {
    if (++this.nodes > MAX_SPEC_NODES) fail(this.source, `the spec holds more than ${MAX_SPEC_NODES} values once its $refs are resolved`);
    if (depth > MAX_SPEC_DEPTH) fail(this.source, `the spec nests deeper than ${MAX_SPEC_DEPTH} levels once its $refs are resolved`);
  }
}

/**
 * A copy with JSON's semantics (what ADK's JSON round trip gave: a Date
 * becomes its ISO string, undefined and functions drop out of an object
 * and become null in an array, a non-finite number becomes null), bounded.
 */
function jsonCopy(value: unknown, budget: Budget, depth = 0): unknown {
  budget.spend(depth);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return undefined;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === 'function') return jsonCopy(withJson.toJSON(), budget, depth);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const copied = jsonCopy(item, budget, depth + 1);
      return copied === undefined ? null : copied;
    });
  }
  const out: Obj = {};
  for (const key of Object.keys(value)) {
    const copied = jsonCopy((value as Obj)[key], budget, depth + 1);
    if (copied !== undefined) put(out, key, copied);
  }
  return out;
}

/** The value a local ref (`#/a/b`) points at, or undefined. Own keys only. */
function lookup(ref: string, doc: unknown, source?: string): unknown {
  const parts = ref.split('/');
  if (parts[0] !== '#') fail(source, `external references are not supported: ${ref}`);
  let current: unknown = doc;
  for (const part of parts.slice(1)) {
    if (typeof current === 'object' && current !== null && Object.hasOwn(current, part)) current = (current as Obj)[part];
    else return undefined;
  }
  return current;
}

/**
 * The document with its local refs replaced by what they point at (ADK's
 * rules, see the header). Every value produced is counted, so expansion is
 * bounded however the refs are arranged.
 */
function resolveRefs(doc: unknown, budget: Budget, source?: string): unknown {
  const resolved = new Map<string, unknown>();
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node !== 'object' || node === null) {
      budget.spend(depth);
      return node;
    }
    if (Array.isArray(node)) {
      budget.spend(depth);
      return node.map((item) => walk(item, depth + 1));
    }
    const ref = (node as Obj).$ref;
    if (typeof ref === 'string') {
      if (seen.has(ref) && !resolved.has(ref)) {
        const { $ref: _cycle, ...rest } = node as Obj;
        return jsonCopy(rest, budget, depth);
      }
      seen.add(ref);
      if (resolved.has(ref)) return jsonCopy(resolved.get(ref), budget, depth);
      const target = lookup(ref, doc, source);
      if (target === undefined) return jsonCopy(node, budget, depth);
      // Following a ref counts as a level, so a long chain of refs is bounded too.
      const value = walk(target, depth + 1);
      resolved.set(ref, value);
      return jsonCopy(value, budget, depth);
    }
    budget.spend(depth);
    const out: Obj = {};
    for (const key of Object.keys(node)) put(out, key, walk((node as Obj)[key], depth + 1));
    return out;
  };
  return walk(doc, 0);
}

const SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

/** Lowercases every `type` inside a schema and drops the ones JSON Schema does not have (in place). */
function sanitizeTypes(node: unknown, inSchema: boolean): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) sanitizeTypes(item, inSchema);
    return;
  }
  const obj = node as Obj;
  if (inSchema && 'type' in obj) {
    const type = obj.type;
    if (typeof type === 'string') {
      if (SCHEMA_TYPES.has(type.toLowerCase())) obj.type = type.toLowerCase();
      else delete obj.type;
    } else if (Array.isArray(type)) {
      const valid: string[] = [];
      for (const entry of type) {
        if (typeof entry !== 'string') continue;
        const lower = entry.toLowerCase();
        if (SCHEMA_TYPES.has(lower) && !valid.includes(lower)) valid.push(lower);
      }
      if (valid.length) obj.type = valid;
      else delete obj.type;
    }
  }
  for (const key of Object.keys(obj)) sanitizeTypes(obj[key], inSchema || key === 'schema' || key === 'schemas');
}

// ── Operations ──────────────────────────────────────────────────────────────

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'] as const;

function serverUrl(server: unknown, source?: string): string {
  if (!isObj(server) || typeof server.url !== 'string') fail(source, 'servers[0] has no url');
  const variables = isObj(server.variables) ? server.variables : {};
  return server.url.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    const variable = Object.hasOwn(variables, name) && isObj(variables[name]) ? (variables[name] as Obj) : undefined;
    const value = variable?.default || (Array.isArray(variable?.enum) ? variable.enum[0] : undefined);
    if (!value) fail(source, `unresolved server URL variable '${name}' in '${server.url}'; declare a default under servers[].variables`);
    return String(value);
  });
}

function schemaOf(value: unknown): Obj {
  return isObj(value) ? value : {};
}

/** The arguments of one operation, in ADK's order and with its names. */
function operationParameters(operation: Obj): OpenApiParameter[] {
  const params: OpenApiParameter[] = [];
  const list = Array.isArray(operation.parameters) ? operation.parameters : [];
  for (const param of list) {
    if (!isObj(param) || !('name' in param)) continue;
    const originalName = String(param.name);
    params.push({
      name: argumentName(originalName),
      originalName,
      location: typeof param.in === 'string' ? param.in : '',
      schema: schemaOf(param.schema),
      description: typeof param.description === 'string' ? param.description : '',
      required: Boolean(param.required),
    });
  }

  const body = operation.requestBody;
  if (isObj(body) && !('$ref' in body)) {
    const content = isObj(body.content) ? body.content : {};
    const mime = Object.keys(content)[0];
    if (mime !== undefined) {
      const media = content[mime];
      const schema = isObj(media) && isObj(media.schema) ? media.schema : {};
      const description = typeof body.description === 'string' ? body.description : '';
      if (!('$ref' in schema)) {
        const whole = (originalName: string): OpenApiParameter => ({
          name: 'body', originalName, location: 'body', schema, description, required: true,
        });
        if (schema.type === 'object') {
          const properties = isObj(schema.properties) ? schema.properties : {};
          const required = Array.isArray(schema.required) ? schema.required : [];
          if (Object.keys(properties).length > 0) {
            for (const [propName, prop] of Object.entries(properties)) {
              if (!isObj(prop) || '$ref' in prop) continue;
              params.push({
                name: argumentName(propName),
                originalName: propName,
                location: 'body',
                schema: prop,
                ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
                required: required.includes(propName),
              });
            }
          } else {
            params.push(whole(''));
          }
        } else if (schema.type === 'array') {
          params.push(whole('array'));
        } else {
          params.push(whole('body'));
        }
      }
    }
  }

  // A repeated name gains the count of the names before it.
  const counts = new Map<string, number>();
  for (const param of params) {
    const count = counts.get(param.name) ?? 0;
    const original = param.name;
    if (count > 0) param.name = `${original}_${count}`;
    counts.set(original, count + 1);
  }
  return params;
}

// ── The declaration ─────────────────────────────────────────────────────────

/** The keywords ADK keeps when it declares an OpenAPI schema (Gemini's schema, less title, default and format). */
const DECLARED_KEYWORDS = new Set([
  'anyOf', 'description', 'enum', 'example', 'items', 'maxItems', 'maxLength', 'maxProperties', 'maximum',
  'minItems', 'minLength', 'minProperties', 'minimum', 'nullable', 'pattern', 'properties', 'propertyOrdering',
  'required', 'type',
]);

/** The property ADK gives an object without properties, which Gemini would refuse. */
export const EMPTY_OBJECT_PLACEHOLDER = 'dummy_DO_NOT_GENERATE';

/** A keyword's name as ADK reads it: snake_case, then camelCase (`max_length` and `MaxLength` are `maxLength`). */
function keywordName(key: string): string {
  const snake = adkSnake(key);
  let out = '';
  for (let i = 0; i < snake.length; i++) {
    const c = snake[i]!;
    if (c === '_' && i + 1 < snake.length && (isLower(snake[i + 1]!) || isDigit(snake[i + 1]!))) {
      out += snake[i + 1]!.toUpperCase();
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** A schema type as the declaration carries it: one JSON Schema type, else `type_unspecified` (what ADK sends). */
function declaredType(type: unknown): string {
  if (typeof type !== 'string') return 'type_unspecified';
  const lower = type.toLowerCase();
  if (lower === 'text') return 'string';
  return SCHEMA_TYPES.has(lower) ? lower : 'type_unspecified';
}

/**
 * One schema as ADK declared it, before the contract's normalisation: only
 * the declared keywords, a missing type an object, an object without
 * properties given the placeholder, properties, items and anyOf recursed.
 */
function declaredSchema(schema: unknown, source: string | undefined, depth: number): Obj {
  if (!isObj(schema)) fail(source, 'a schema in the spec is not an object');
  if (depth > MAX_SPEC_DEPTH) fail(source, `a schema nests deeper than ${MAX_SPEC_DEPTH} levels`);
  const node: Obj = {};
  for (const key of Object.keys(schema)) put(node, key, schema[key]);
  if (!node.type) node.type = 'object';
  const props = node.properties;
  if (node.type === 'object' && !(isObj(props) && Object.keys(props).length > 0)) {
    node.properties = { [EMPTY_OBJECT_PLACEHOLDER]: { type: 'string' } };
  }
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    const field = keywordName(key);
    if (!DECLARED_KEYWORDS.has(field)) continue;
    let converted: unknown = value;
    if (field === 'type') converted = declaredType(value);
    else if (field === 'properties' && isObj(value)) {
      const properties: Obj = {};
      for (const [name, prop] of Object.entries(value)) put(properties, name, declaredSchema(prop, source, depth + 1));
      converted = properties;
    } else if (field === 'items' && isObj(value)) converted = declaredSchema(value, source, depth + 1);
    else if (field === 'anyOf' && Array.isArray(value)) converted = value.map((item) => declaredSchema(item, source, depth + 1));
    put(out, field, converted);
  }
  return out;
}

/** The parameters object of an operation's declaration, in the contract's dialect. */
function declaredParameters(params: OpenApiParameter[], source?: string): JsonSchema {
  const properties: Obj = {};
  const required: string[] = [];
  for (const param of params) {
    put(properties, param.name, param.schema);
    if (param.required) required.push(param.name);
  }
  return toContractJsonSchema(declaredSchema({ type: 'object', properties, required }, source, 0));
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Every operation of a parsed OpenAPI document. Throws, with a readable
 * message, on a document that is not an object, an external ref, a server
 * URL variable without a value, or a spec beyond the limits.
 */
export function parseOpenApiDocument(document: unknown, options: ParseOptions = {}): OpenApiOperation[] {
  const { prefix, source } = options;
  if (!isObj(document)) fail(source, 'the spec is not an OpenAPI document (an object)');
  const budget = new Budget(source);
  const copy = jsonCopy(document, budget);
  const spec = resolveRefs(copy, new Budget(source), source) as Obj;
  sanitizeTypes(spec, false);

  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const baseUrl = servers.length ? serverUrl(servers[0], source) : '';
  const firstSchemeName = (security: unknown): string | undefined =>
    Array.isArray(security) && isObj(security[0]) ? Object.keys(security[0])[0] : undefined;
  const globalScheme = firstSchemeName(spec.security);
  const components = isObj(spec.components) ? spec.components : {};
  const schemes = isObj(components.securitySchemes) ? components.securitySchemes : {};

  const operations: OpenApiOperation[] = [];
  const paths = isObj(spec.paths) ? spec.paths : {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObj(pathItem)) continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isObj(operation)) continue;
      const own = Array.isArray(operation.parameters) ? operation.parameters : [];
      const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      operation.parameters = [...own, ...shared];
      if (!operation.operationId) operation.operationId = adkSnake(`${path}_${method}`);
      const operationId = String(operation.operationId);

      const fnName = argumentName(operationId).slice(0, MAX_TOOL_NAME);
      const name = (prefix ? `${prefix}_${fnName}` : fnName).slice(0, MAX_TOOL_NAME);
      const description = String(operation.description || operation.summary || '');
      const parameters = operationParameters(operation);
      const schemeName = firstSchemeName(operation.security) ?? globalScheme;
      const authScheme = schemeName && Object.hasOwn(schemes, schemeName) && isObj(schemes[schemeName]) ? (schemes[schemeName] as Obj) : undefined;

      operations.push({
        name,
        operationId,
        method,
        path,
        baseUrl,
        description,
        parameters,
        declaration: { name, description, parameters: declaredParameters(parameters, source) },
        operation,
        ...(authScheme ? { authScheme } : {}),
      });
    }
  }
  return operations;
}

/** Every operation of a spec's text (`json` or `yaml`). */
export function parseOpenApiSpec(text: string, format: 'json' | 'yaml', options: ParseOptions = {}): OpenApiOperation[] {
  return parseOpenApiDocument(readSpecText(text, format, options.source), options);
}
