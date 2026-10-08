/**
 * lib/adkPeer.ts — @google/adk as an optional peer (ADR 0102).
 *
 * WHY this file exists:
 *   From 0.20.0 the native runtime is the default, and @google/adk is needed
 *   only for MELCHIZEDEK_RUNTIME=adk and the features only ADK runs. Until
 *   1.0.0 removes ADK (ADR 0045), the engine's objects still carry an ADK
 *   face: the tool registry holds FunctionTools that carry their own Tool,
 *   the model shims are BaseLlm classes that carry their contract adapter,
 *   and the durable session stores are ADK BaseSessionServices as well as
 *   the engine's SessionService. Those classes extend ADK's at load time.
 *
 *   This module is the one place the package loads ADK. It tries once, when
 *   it is first imported, and every other module takes ADK's values from
 *   here, never from '@google/adk' directly (a type-only import is fine):
 *   - When ADK is installed, each export below IS ADK's own value, so the
 *     ADK runtime, `instanceof` and ADK's registry behave exactly as before.
 *   - When it is not, the base classes are stand-ins: they construct as
 *     ADK's do (a tool's name, a model's id, a toolset's filter) and carry
 *     ADK's own Symbol.for marks, so the engine reads them as it reads ADK's,
 *     and every method only ADK calls throws AdkNotInstalledError, which
 *     names the package. Everything else (`Runner`, `LlmAgent`, the plugins)
 *     is reached through requireAdk(feature), which throws the same error.
 *
 *   A package that is installed but fails to load for another reason (a
 *   missing dependency of its own, a syntax error) is not "absent": that
 *   error is rethrown, so nothing hides a broken install.
 *
 * The load is a top-level await of a dynamic import: an ES module cannot
 * load another synchronously, and the exported classes must exist before
 * any subclass is defined.
 */

import type * as AdkModule from '@google/adk';

/** The package this module loads. */
export const ADK_PACKAGE = '@google/adk';

/** @google/adk's module namespace, as its types describe it. */
export type Adk = typeof AdkModule;

/** Whether `err` says the package itself could not be found (and not a module it imports). */
function isMissingPackage(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND') return false;
  return typeof e.message === 'string' && e.message.includes(`'${ADK_PACKAGE}'`);
}

let loaded: Adk | undefined;
try {
  loaded = await import('@google/adk');
} catch (err) {
  if (!isMissingPackage(err)) throw err;
}

/** ADK's module when it is installed, else undefined. */
export const adk: Adk | undefined = loaded;

/** Whether @google/adk is installed and loaded. */
export function adkInstalled(): boolean {
  return loaded !== undefined;
}

/** The installed @google/adk version, read from its package.json, or undefined when it is not installed. */
export async function adkVersion(): Promise<string | undefined> {
  if (!loaded) return undefined;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const fs = await import('node:fs');
    const path = await import('node:path');
    // The package's exports map hides package.json, so walk up from its entry.
    let dir = path.dirname(require.resolve(ADK_PACKAGE));
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === ADK_PACKAGE) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Unreadable: the version is unknown, not the package absent.
  }
  return undefined;
}

/** A feature only ADK runs was used without @google/adk installed. */
export class AdkNotInstalledError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(
      `${feature} needs ${ADK_PACKAGE}, which is not installed. ` +
        `Install it beside melchizedek-agents (npm install ${ADK_PACKAGE}@~2.2.0), ` +
        `or run on the native runtime (the default; unset MELCHIZEDEK_RUNTIME or set it to native).`,
    );
    this.name = 'AdkNotInstalledError';
    this.feature = feature;
  }
}

/** ADK's module, or AdkNotInstalledError naming `feature` when it is not installed. */
export function requireAdk(feature: string): Adk {
  if (!loaded) throw new AdkNotInstalledError(feature);
  return loaded;
}

// ── Stand-ins for ADK's base classes ─────────────────────────────────────────
//
// Each matches the ADK constructor's effect on the instance and ADK's
// Symbol.for mark, nothing more. They exist only when ADK is not installed.

const BASE_TOOL = Symbol.for('google.adk.baseTool');
const IN_MODEL_TOOL = Symbol.for('google.adk.inModelTool');
const FUNCTION_TOOL = Symbol.for('google.adk.functionTool');
const BASE_TOOLSET = Symbol.for('google.adk.baseToolset');
const BASE_MODEL = Symbol.for('google.adk.baseModel');
const GEMINI_MODEL = Symbol.for('google.adk.geminiModel');

function adkOnly(what: string): never {
  throw new AdkNotInstalledError(what);
}

class MissingBaseTool {
  readonly [BASE_TOOL] = true;
  name: string;
  description: string;
  isLongRunning: boolean;

  constructor(params: { name: string; description: string; isLongRunning?: boolean }) {
    this.name = params.name;
    this.description = params.description;
    this.isLongRunning = params.isLongRunning ?? false;
  }

  _getDeclaration(): undefined {
    return undefined;
  }

  async checkRequireConfirmation(): Promise<boolean> {
    return false;
  }

  async processLlmRequest(_request?: unknown): Promise<void> {
    adkOnly(`The ADK face of the tool '${this.name}'`);
  }

  async runAsync(_request?: unknown): Promise<unknown> {
    return adkOnly(`The ADK face of the tool '${this.name}'`);
  }
}

class MissingFunctionTool extends MissingBaseTool {
  readonly [FUNCTION_TOOL] = true;
  execute: unknown;
  parameters: unknown;
  requireConfirmation: unknown;

  constructor(options: { name?: string; description: string; parameters?: unknown; execute: { name?: string }; isLongRunning?: boolean; requireConfirmation?: unknown }) {
    const name = options.name ?? options.execute.name;
    if (!name) throw new Error('Tool name cannot be empty. Either name the `execute` function or provide a `name`.');
    super({ name, description: options.description, isLongRunning: options.isLongRunning });
    this.execute = options.execute;
    this.parameters = options.parameters;
    this.requireConfirmation = options.requireConfirmation ?? false;
  }
}

class MissingBaseToolset {
  readonly [BASE_TOOLSET] = true;
  toolFilter: unknown;
  prefix: string | undefined;

  constructor(toolFilter: unknown, prefix?: string) {
    this.toolFilter = toolFilter;
    this.prefix = prefix;
  }

  async getTools(): Promise<unknown[]> {
    return adkOnly('An ADK toolset');
  }

  async close(): Promise<void> {}
}

class MissingBaseLlm {
  readonly [BASE_MODEL] = true;
  readonly model: string;
  static readonly supportedModels: Array<string | RegExp> = [];

  constructor({ model }: { model: string }) {
    this.model = model;
  }

  generateContentAsync(): AsyncGenerator<never, void> {
    return adkOnly(`The ADK face of the model '${this.model}'`);
  }

  async connect(): Promise<never> {
    return adkOnly(`The ADK face of the model '${this.model}'`);
  }
}

/**
 * ADK's Gemini, absent: it holds what a caller gave it (the model, a key,
 * Vertex AI's settings), as ADK's does, so the native runtime reads it as it
 * reads TracedGemini (lib/compileNative.ts). Calling it throws.
 */
class MissingGemini extends MissingBaseLlm {
  readonly [GEMINI_MODEL] = true;
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  headers?: Record<string, string>;

  constructor(params: { model?: string; apiKey?: string; vertexai?: boolean; project?: string; location?: string; headers?: Record<string, string> }) {
    super({ model: params.model ?? 'gemini-2.5-flash' });
    if (params.apiKey !== undefined) this.apiKey = params.apiKey;
    if (params.vertexai !== undefined) this.vertexai = params.vertexai;
    if (params.project !== undefined) this.project = params.project;
    if (params.location !== undefined) this.location = params.location;
    if (params.headers !== undefined) this.headers = params.headers;
  }
}

/**
 * ADK's session service base, absent. A store that extends it is still the
 * engine's SessionService; only the ADK face (the base's appendEvent, which
 * ADK's Runner reaches) needs ADK.
 */
class MissingBaseSessionService {
  async appendEvent(_request: unknown): Promise<never> {
    return adkOnly('The ADK face of a session store');
  }

  /** ADK's own: the session when it exists, else a new one, through the store's methods. */
  async getOrCreateSession(request: { appName: string; userId: string; sessionId?: string }): Promise<unknown> {
    const self = this as unknown as {
      getSession(r: { appName: string; userId: string; sessionId: string }): Promise<unknown>;
      createSession(r: unknown): Promise<unknown>;
    };
    if (!request.sessionId) return self.createSession(request);
    const session = await self.getSession({ appName: request.appName, userId: request.userId, sessionId: request.sessionId });
    return session ?? self.createSession(request);
  }
}

/** ADK's GOOGLE_SEARCH, absent: an in-model tool named google_search, which the engine reads by ADK's mark. */
class MissingGoogleSearchTool extends MissingBaseTool {
  readonly [IN_MODEL_TOOL] = true;

  constructor() {
    super({ name: 'google_search', description: 'Google Search Tool' });
  }
}

// ── The values every other module imports ────────────────────────────────────
//
// A type of the same name sits beside each value, so `import { BaseTool }`
// from here serves as both, as it did from '@google/adk'.

export const BaseTool: Adk['BaseTool'] = loaded?.BaseTool ?? (MissingBaseTool as unknown as Adk['BaseTool']);
export type BaseTool = AdkModule.BaseTool;

export const FunctionTool: Adk['FunctionTool'] = loaded?.FunctionTool ?? (MissingFunctionTool as unknown as Adk['FunctionTool']);
export type FunctionTool<TParameters extends AdkModule.ToolInputParameters = undefined> = AdkModule.FunctionTool<TParameters>;

export const BaseToolset: Adk['BaseToolset'] = loaded?.BaseToolset ?? (MissingBaseToolset as unknown as Adk['BaseToolset']);
export type BaseToolset = AdkModule.BaseToolset;

export const BaseLlm: Adk['BaseLlm'] = loaded?.BaseLlm ?? (MissingBaseLlm as unknown as Adk['BaseLlm']);
export type BaseLlm = AdkModule.BaseLlm;

export const Gemini: Adk['Gemini'] = loaded?.Gemini ?? (MissingGemini as unknown as Adk['Gemini']);
export type Gemini = AdkModule.Gemini;

export const BaseSessionService: Adk['BaseSessionService'] = loaded?.BaseSessionService ?? (MissingBaseSessionService as unknown as Adk['BaseSessionService']);
export type BaseSessionService = AdkModule.BaseSessionService;

export const GOOGLE_SEARCH: Adk['GOOGLE_SEARCH'] = loaded?.GOOGLE_SEARCH ?? (new MissingGoogleSearchTool() as unknown as Adk['GOOGLE_SEARCH']);
