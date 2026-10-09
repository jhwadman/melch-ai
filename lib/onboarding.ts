/**
 * lib/onboarding.ts — the authentication levels and their startup guides.
 *
 * WHY this file exists:
 *   A newcomer arrives with something: no key, one provider's key, several, a
 *   gateway key, a cloud account, a server to put in front of other people,
 *   or a ChatGPT / Claude.ai / Gemini CLI sign-in. Each of those is a
 *   different first ten minutes. This module names those levels once, from
 *   what the engine actually supports (lib/models/providerMap.ts,
 *   endpoints.ts, gateway.ts, the A2A server's identity modes and the OAuth
 *   grant setup), and renders one startup guide per level. The
 *   `melchizedek-setup` menu prints these guides and ONBOARDING.md is
 *   generated from the same function, so the two cannot drift
 *   (tests/onboarding.test.ts holds them equal).
 *
 * DETECTION IS THE DOCTOR'S:
 *   `detectLevels` reads a DoctorResult (lib/doctor.ts: the providers line,
 *   the gateway, the cloud endpoints, the serving and OAuth lines). It never
 *   reads a key itself, so `--auto` cannot disagree with the doctor.
 *
 * WHAT IT NEVER DOES:
 *   print a value. Guides carry variable NAMES and SHAPES; detection carries
 *   names and set/unset. Writing `.env` (writeEnvForLevel) copies
 *   `.env.example`, leaves every chosen name blank, refuses to overwrite an
 *   existing file, and refuses unless `git check-ignore` says `.env` is
 *   ignored (secrets-hygiene).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diagnoseSyndicate } from './doctor.ts';
import type { DoctorResult, Tier } from './doctor.ts';
import { GATEWAY_ENV, GATEWAY_KEY_ENV, GATEWAYS } from './models/gateway.ts';
import { PROVIDERS } from './models/providerMap.ts';
import type { ProviderId } from './models/providerMap.ts';
import { CREDENTIAL_KEY_ENV } from './tools/credentialCipher.ts';
import { OAUTH_HOSTS_ENV } from './tools/oauthHosts.ts';
import { OAUTH_REDIRECT_URI_ENV } from './a2a/oauthSetup.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type LevelId =
  | 'local'
  | 'one-provider'
  | 'several-providers'
  | 'gateway'
  | 'cloud-platform'
  | 'byok'
  | 'caller-tokens'
  | 'oauth-grants'
  | 'subscription-signin';

/** How a command is spelled: in a project that installed the package, or in a clone of the repository. */
export type CommandForm = 'package' | 'clone';

export interface EnvLine {
  name: string;
  /** The shape of the value, never a value. */
  shape: string;
  /** What setting it does. */
  purpose: string;
}

export interface Level {
  id: LevelId;
  /** The menu line: what the user has. */
  menu: string;
  title: string;
  summary: string;
  env: EnvLine[];
  /** What the doctor shows when this level is set up. */
  confirm: string;
  /** Shipped syndicates that run at this level, rendered by `shippedFor`. */
  runs: (shipped: ShippedIndex) => string[];
  first: Record<CommandForm, string[]>;
  notes: string[];
  /** The onboarding skill a coding agent follows for this level. */
  skill: string;
  /** False for an entry that is not a way to run the engine (subscription sign-ins). */
  detectable: boolean;
}

/** Shipped templates and examples by the tier their models imply, and which declare an OAuth grant. */
export interface ShippedIndex {
  byTier: Partial<Record<Tier, string[]>>;
  withGrants: string[];
  /** Files that carry a commented-out `oauth2:` grant to start from. */
  grantExamples: string[];
  templates: string[];
}

// ── Where the package lives ──────────────────────────────────────────────────

/** The package (or clone) root: the directory holding config/agents/syndicate.schema.json. */
export function packageRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'config', 'agents', 'syndicate.schema.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('config/agents/ not found beside the package');
}

/**
 * Index the shipped templates and examples by tier, using the doctor's own
 * diagnosis (lib/doctor.ts `diagnoseSyndicate`: the tier the models imply,
 * and the OAuth grants the tools declare). The tier does not depend on the
 * environment, so the index is the same wherever it is computed.
 */
export function shippedIndex(root: string = packageRoot()): ShippedIndex {
  const agentsDir = join(root, 'config', 'agents');
  const index: ShippedIndex = { byTier: {}, withGrants: [], grantExamples: [], templates: [] };
  for (const dir of ['templates', 'examples']) {
    const full = join(agentsDir, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full).filter((x) => x.endsWith('.yaml')).sort()) {
      const name = f.slice(0, -5);
      const label = `${name} (${dir.slice(0, -1)})`;
      if (dir === 'templates') index.templates.push(name);
      const d = diagnoseSyndicate(`${dir}/${f}`, agentsDir);
      if (d.error) continue;
      (index.byTier[d.tier] ??= []).push(label);
      if (d.grants?.length) index.withGrants.push(label);
      else if (/^\s*#\s+oauth2:\s*$/m.test(readFileSync(join(full, f), 'utf-8'))) index.grantExamples.push(label);
    }
  }
  return index;
}

// ── Commands, spelled per form ───────────────────────────────────────────────

const CMD = {
  doctor: { package: 'npx melchizedek-doctor', clone: 'npm run doctor' },
  setup: { package: 'npx melchizedek-setup', clone: 'npm run setup --' },
} as const;

function init(form: CommandForm, template: string): string {
  return form === 'package' ? `npx melchizedek-init --template ${template}` : `npm run init -- --template ${template}`;
}
function chat(form: CommandForm, name: string): string {
  return form === 'package' ? `npx melchizedek-chat --syndicate ${name}` : `npm run chat:syndicate -- --syndicate ${name}`;
}
function serve(form: CommandForm, file: string): string {
  return form === 'package' ? `npx melchizedek-serve ${file}` : `npm run start:a2a -- ${file}`;
}
function newCaller(form: CommandForm, name: string): string {
  const flags = `--new-caller ${name} --token-file "$HOME/${name}.token"`;
  return form === 'package' ? `npx melchizedek-serve ${flags}` : `npm run start:a2a -- ${flags}`;
}

// ── The levels ───────────────────────────────────────────────────────────────

const PROVIDER_CONSOLE: Record<Exclude<ProviderId, 'ollama'>, string> = {
  gemini: 'https://aistudio.google.com',
  anthropic: 'https://console.anthropic.com',
  openai: 'https://platform.openai.com/api-keys',
  xai: 'https://console.x.ai',
  moonshot: 'https://platform.moonshot.ai',
};

const PREFIX: Record<Exclude<ProviderId, 'ollama'>, string> = {
  gemini: 'gemini-* (and any id without another prefix)',
  anthropic: 'claude-*',
  openai: 'gpt-*, o<digit>*',
  xai: 'grok-*',
  moonshot: 'kimi-*',
};

const CLOUD_PROVIDERS = Object.keys(PROVIDER_CONSOLE) as Exclude<ProviderId, 'ollama'>[];

function providerKeyLines(): EnvLine[] {
  return CLOUD_PROVIDERS.map((p) => ({
    name: PROVIDERS[p].keyEnv!,
    shape: `an API key from ${PROVIDER_CONSOLE[p]}`,
    purpose: `${PROVIDERS[p].label}: model ids ${PREFIX[p]}${p === 'gemini' ? '; also the default embedder for long-term memory (GEMINI_API_KEY is accepted too)' : ''}`,
  }));
}

function list(items: string[] | undefined): string {
  return items?.length ? items.join(', ') : 'no shipped file yet (change a `model:` line to use one)';
}

const SERVE_POSTURE: EnvLine[] = [
  { name: 'PUBLIC_URL', shape: 'https://agents.example.com', purpose: 'only on a public deployment; it then requires the three below' },
  { name: 'A2A_SERVED_AGENTS', shape: 'comma list of agent ids, or *', purpose: 'which agents the server answers (required with PUBLIC_URL)' },
  { name: 'A2A_TRUST_PROXY', shape: '1 behind one load balancer, or false', purpose: 'required with PUBLIC_URL' },
];

export const LEVELS: readonly Level[] = [
  {
    id: 'local',
    menu: 'Nothing yet: run open-weight models locally (Ollama, no key)',
    title: 'No keys: local models only',
    summary:
      'Every agent whose model id starts with `ollama/` runs on your machine through Ollama. No account, no key, and no data leaves the machine. Install Ollama from https://ollama.com and pull a model: `ollama pull qwen3:8b`.',
    env: [
      { name: 'OLLAMA_BASE_URL', shape: 'http://localhost:11434/v1', purpose: 'optional: only for a non-default Ollama endpoint' },
    ],
    confirm: 'the providers line shows `Ollama (local) local`, and the keyless files read `ready — local, no key`.',
    runs: (s) => [`keyless: ${list(s.byTier.keyless)}`],
    first: {
      package: [init('package', 'conversational'), chat('package', 'conversational')],
      clone: ['npm run syndicate:assistant'],
    },
    notes: [
      'Server-side search tools (web_search, google_search, x_search) are not available on Ollama; the doctor lists what each agent drops.',
      'Ollama serves a 4,096-token context by default; start it with `OLLAMA_CONTEXT_LENGTH=16384 ollama serve` before summarizing web pages.',
    ],
    skill: 'melchizedek-onboard-local',
    detectable: true,
  },
  {
    id: 'one-provider',
    menu: "One provider's API key (Gemini, Anthropic, OpenAI, xAI or Moonshot)",
    title: "One provider's API key",
    summary:
      "The model id's prefix picks the provider, and that provider's key funds it. One key runs every file whose agents all use that provider. A Gemini key runs the most shipped files and also powers long-term memory's embeddings.",
    env: providerKeyLines(),
    confirm: 'the providers line shows a ✓ beside your provider, and the files of that tier read `ready`.',
    runs: (s) => [
      ...CLOUD_PROVIDERS.map((p) => `${PROVIDERS[p].keyEnv}: ${list(s.byTier[p])}`),
      `with no key at all: ${list(s.byTier.keyless)}`,
    ],
    first: {
      package: [init('package', 'research_brief'), chat('package', 'research_brief')],
      clone: ['npm run chat:syndicate', 'npm run syndicate:claude   # with ANTHROPIC_API_KEY instead'],
    },
    notes: [
      'Set only the one variable you have; leave the others blank. The doctor names, per file, the variable that would unblock it.',
      'To run a shipped file on your provider, change its `model:` lines (for example `gemini-3.8-flash` to `claude-sonnet-4-6`); `doctor` then shows it ready.',
    ],
    skill: 'melchizedek-onboard-keys',
    detectable: true,
  },
  {
    id: 'several-providers',
    menu: 'API keys for several providers',
    title: 'Several providers',
    summary:
      'Each key funds its own provider, and a syndicate may mix them: one agent on Claude, another on Gemini, a third local. A direct key always serves its provider at full fidelity (native search included).',
    env: providerKeyLines(),
    confirm: 'a ✓ beside each provider you set; `multi-provider` files read `ready` once every provider they use has its key.',
    runs: (s) => [
      `multi-provider: ${list(s.byTier['multi-provider'])}`,
      'plus every single-provider file whose key you set (see level 2)',
    ],
    first: {
      package: [init('package', 'model_zoo'), chat('package', 'model_zoo')],
      clone: ['npm run demo:models   # one prompt to every provider you have a key for'],
    },
    notes: [
      'A provider you have no key for can still be served by a gateway (level 4); a direct key set beside it wins for its own provider.',
    ],
    skill: 'melchizedek-onboard-keys',
    detectable: true,
  },
  {
    id: 'gateway',
    menu: 'One gateway key (Vercel AI Gateway or OpenRouter)',
    title: 'A gateway key',
    summary:
      "One key serves every cloud model id whose direct key is absent, through the gateway's OpenAI-compatible endpoint. It is a fallback, never a preempt: a direct key always wins for its provider. Ollama never goes through it.",
    env: [
      { name: GATEWAY_ENV, shape: 'vercel | openrouter', purpose: 'which gateway' },
      { name: GATEWAY_KEY_ENV, shape: 'the gateway key (https://vercel.com/ai-gateway or https://openrouter.ai/keys)', purpose: 'funds every id with no direct key' },
      { name: 'MODEL_GATEWAY_BASE_URL', shape: 'https URL', purpose: 'optional: a self-hosted proxy speaking the same dialect (LiteLLM)' },
      { name: 'MODEL_GATEWAY_MODEL_MAP', shape: 'yaml-id=gateway-id,yaml-id=gateway-id', purpose: 'optional: fix an id the default mapping gets wrong' },
    ],
    confirm: 'a `gateway` line with no ✗, and providers without a direct key marked `◇ via gateway`.',
    runs: (s) => [
      `every cloud file: ${list([...CLOUD_PROVIDERS.flatMap((p) => s.byTier[p] ?? []), ...(s.byTier['multi-provider'] ?? [])])}`,
    ],
    first: {
      package: [init('package', 'research_brief'), chat('package', 'research_brief')],
      clone: ['npm run chat:syndicate'],
    },
    notes: [
      'Native search is lost on the gateway path (Gemini grounding, Anthropic and OpenAI web_search, xAI x_search); the doctor marks each dropped tool.',
      'Long-term memory embeds through Gemini by default, which the gateway does not serve: set GOOGLE_GENAI_API_KEY, or MEMORY_EMBEDDING_PROVIDER=openai or ollama.',
    ],
    skill: 'melchizedek-onboard-keys',
    detectable: true,
  },
  {
    id: 'cloud-platform',
    menu: 'Cloud platform credentials (Vertex AI, Amazon Bedrock, Azure OpenAI)',
    title: 'Cloud platform credentials',
    summary:
      "The model id still picks the provider; these variables pick the cloud it is reached through, authenticated by that cloud's own credential chain instead of a vendor API key. Gemini and Claude on Vertex AI use Google Application Default Credentials (`gcloud auth application-default login`, or a service account); Claude on Bedrock uses the AWS credential chain; GPT on Azure uses an Azure key or Entra ID.",
    env: [
      { name: 'GEMINI_PLATFORM', shape: 'vertex', purpose: 'Gemini on Vertex AI (ADC)' },
      { name: 'GOOGLE_CLOUD_PROJECT', shape: 'a Google Cloud project id', purpose: 'Vertex AI project' },
      { name: 'GOOGLE_CLOUD_LOCATION', shape: 'a region, or global', purpose: 'Vertex AI location' },
      { name: 'ANTHROPIC_PLATFORM', shape: 'bedrock | vertex', purpose: 'Claude on Bedrock (`npm install @anthropic-ai/bedrock-sdk`) or Vertex AI (`npm install @anthropic-ai/vertex-sdk`)' },
      { name: 'AWS_REGION', shape: 'an AWS region, e.g. us-east-1', purpose: 'Bedrock region; credentials come from the AWS chain (profile, role, SSO)' },
      { name: 'ANTHROPIC_VERTEX_PROJECT_ID', shape: 'a Google Cloud project id', purpose: 'Claude on Vertex AI (falls back to GOOGLE_CLOUD_PROJECT)' },
      { name: 'CLOUD_ML_REGION', shape: 'a region', purpose: 'Claude on Vertex AI (falls back to GOOGLE_CLOUD_LOCATION)' },
      { name: 'OPENAI_PLATFORM', shape: 'azure', purpose: 'GPT on Azure OpenAI' },
      { name: 'AZURE_OPENAI_ENDPOINT', shape: 'https://<resource>.openai.azure.com', purpose: 'the Azure OpenAI resource' },
      { name: 'AZURE_OPENAI_API_KEY', shape: 'an Azure OpenAI key', purpose: 'optional: without it, Entra ID (`npm install @azure/identity`)' },
      { name: 'ANTHROPIC_MODEL_MAP', shape: 'JSON: {"yaml-id":"platform-id"}', purpose: 'optional: Bedrock or Vertex model ids (OPENAI_MODEL_MAP for Azure deployments, GEMINI_MODEL_MAP likewise)' },
    ],
    confirm: 'one `endpoint` line per provider on a cloud platform, with no ✗; the credential chain itself is not exercised by the doctor.',
    runs: (s) => [
      `Gemini on Vertex AI: ${list(s.byTier.gemini)}`,
      `Claude on Bedrock or Vertex AI: ${list(s.byTier.anthropic)}`,
      `GPT on Azure OpenAI: ${list(s.byTier.openai)}`,
    ],
    first: {
      package: [init('package', 'research_brief'), chat('package', 'research_brief')],
      clone: ['npm run chat:syndicate'],
    },
    notes: [
      'The Vertex AI, Bedrock and Azure paths are tested against mocks and have not been run against the live clouds from this repository; the doctor says so.',
      "Anthropic's and OpenAI's server-side web_search are not sent on Bedrock, Claude on Vertex AI or Azure; Gemini grounding works on Vertex AI.",
    ],
    skill: 'melchizedek-onboard-cloud',
    detectable: true,
  },
  {
    id: 'byok',
    menu: 'Serving over A2A where each caller brings its own model key (BYOK)',
    title: 'Per-caller keys when serving over A2A (BYOK)',
    summary:
      "The A2A server lets each caller fund its own inference: the caller sends its key in `X-API-Key` and the provider in `X-Provider`, and agents on that provider run on that key for that request. Agents on other providers, tools and memory extraction still run on the server's keys.",
    env: [
      { name: 'A2A_KEY_MODE', shape: 'byok', purpose: "callers' X-API-Key funds X-Provider (default: server)" },
      { name: 'A2A_SERVER_SECRET', shape: '64 hex characters (`openssl rand -hex 32`)', purpose: 'the bearer secret callers present (or caller tokens: level 7)' },
    ],
    confirm: 'a `serving` line reading `A2A_KEY_MODE=byok` with no ✗.',
    runs: (s) => [`any file; start from a template: ${s.templates.join(', ')}`],
    first: {
      package: [init('package', 'conversational'), serve('package', 'conversational.yaml')],
      clone: [serve('clone', 'syndicate.yaml'), 'node demo/a2a_demo.mjs   # sends your Gemini key as X-API-Key'],
    },
    notes: [
      'Under A2A_AUTH=secret, byok also scopes data by a hash of the caller\'s key; with caller tokens or JWTs the identity scopes data and byok only pays.',
      'Without A2A_SERVER_SECRET or caller tokens the server binds 127.0.0.1 only; set one before anyone else calls it.',
    ],
    skill: 'melchizedek-onboard-serve',
    detectable: true,
  },
  {
    id: 'caller-tokens',
    menu: 'Serving to other backends or users with their own tokens (A2A_AUTH)',
    title: 'Serving with caller tokens (A2A_AUTH)',
    summary:
      'A2A_AUTH decides who a caller is, and so whose data a request touches. `callers` gives each calling backend its own bearer token (the config holds only its SHA-256); `jwt` accepts your identity provider\'s tokens; `header` trusts a user header set by an authenticating gateway that alone holds the secret; `secret` (the default) is one shared bearer secret.',
    env: [
      { name: 'A2A_AUTH', shape: 'callers | jwt | header | secret', purpose: 'the identity mode (required with PUBLIC_URL)' },
      { name: 'A2A_CALLERS', shape: 'name:sha256[:scope];name:sha256[:scope]', purpose: `callers: mint each with \`melchizedek-serve --new-caller <name>\`` },
      { name: 'A2A_JWT_ISSUER', shape: 'https://your-idp.example/', purpose: 'jwt: required iss' },
      { name: 'A2A_JWT_AUDIENCE', shape: 'an audience string', purpose: 'jwt: required aud' },
      { name: 'A2A_JWT_JWKS_URL', shape: 'https URL of the JWKS', purpose: 'jwt: RS256/ES256 keys (or A2A_JWT_SECRET, HS256, 32+ characters)' },
      { name: 'A2A_TRUSTED_USER_HEADER', shape: 'a header name, e.g. X-Authenticated-User', purpose: 'header: set by your gateway' },
      { name: 'A2A_SERVER_SECRET', shape: '64 hex characters (`openssl rand -hex 32`)', purpose: 'secret and header modes' },
      ...SERVE_POSTURE,
    ],
    confirm: 'a `serving` line naming your A2A_AUTH mode with no ✗.',
    runs: (s) => [`any file; start from a template: ${s.templates.join(', ')}`],
    first: {
      package: [init('package', 'support_triage'), newCaller('package', 'my-backend'), serve('package', 'support_triage.yaml')],
      clone: [newCaller('clone', 'my-backend'), serve('clone', 'support_triage.yaml')],
    },
    notes: [
      '`--new-caller --token-file` writes the token to a new mode-600 file outside the project and prints only the `A2A_CALLERS` entry (a hash); move the token into the calling backend\'s secret store and delete the file. Without `--token-file` the token is printed once, so do not run it where a transcript is kept.',
      'Prefer callers or jwt on a public URL: under `secret`, any holder of the secret can act as any user by naming them in X-User-Id.',
    ],
    skill: 'melchizedek-onboard-serve',
    detectable: true,
  },
  {
    id: 'oauth-grants',
    menu: "Tools that act for end users on third-party APIs (OAuth grants)",
    title: 'OAuth tool grants for end users',
    summary:
      "A tool declared with `auth: { oauth2 }` (or an MCP server with `mcp_auth`) sends a third-party token. An authorization_code grant pauses the turn until the user consents; the token is sealed per user with the credential key and only sent to hosts the operator binds. A client_credentials grant uses the server's own client.",
    env: [
      { name: CREDENTIAL_KEY_ENV, shape: '32 random bytes, base64 or 64 hex (`openssl rand -base64 32`)', purpose: "seals each user's tokens; keep it out of the database and its backups" },
      { name: OAUTH_REDIRECT_URI_ENV, shape: 'https://agents.example.com/oauth/callback (no query)', purpose: 'the consent callback, registered at every provider; needs the key' },
      { name: OAUTH_HOSTS_ENV, shape: 'provider=host,host;provider=host', purpose: "the hosts each provider's tokens may go to; unset, authorization_code grants are refused" },
      { name: 'OAUTH_CALLBACK_IDENTITY', shape: 'required | state', purpose: 'required (default) needs A2A_AUTH=header behind a gateway' },
      { name: 'DATABASE_URL', shape: 'postgres://…', purpose: 'durable sealed store; without it, grants live in process memory' },
    ],
    confirm: 'an `oauth` line with no ✗, and each `⚿` grant line naming no unset variable.',
    runs: (s) => [
      `declares a grant: ${s.withGrants.length ? s.withGrants.join(', ') : 'no shipped file declares one active'}`,
      `carries a commented grant to uncomment: ${s.grantExamples.length ? s.grantExamples.join(', ') : 'none'}`,
    ],
    first: {
      package: [init('package', 'systems_operator'), '# uncomment its mcp_auth block, then:', 'npx melchizedek-doctor   # names the client id and secret variables the grant reads', serve('package', 'systems_operator.yaml')],
      clone: [init('clone', 'systems_operator'), '# uncomment the mcp_auth block in config/agents/systems_operator.yaml, then:', 'npm run doctor   # names the client id and secret variables the grant reads', serve('clone', 'systems_operator.yaml')],
    },
    notes: [
      "Each grant's client id and secret are read from variables the YAML names (client_id_env, client_secret_env); the framework's own settings are refused there.",
      'This level sits on top of a serving level: set A2A_AUTH first (level 7).',
    ],
    skill: 'melchizedek-onboard-serve',
    detectable: true,
  },
  {
    id: 'subscription-signin',
    menu: 'A ChatGPT / Codex, Claude.ai or Gemini CLI sign-in (no API key)',
    title: 'Subscription sign-ins (ChatGPT / Codex, Claude.ai, Gemini CLI)',
    summary:
      "Not supported, on purpose. A consumer subscription sign-in authorizes that vendor's own apps. The engine does not read, reuse or relay those tokens: Anthropic and Google say third-party apps may not use them, and OpenAI's plan-usage sign-in is a preview for approved or locally hosted apps that this engine has not integrated. Use the same vendor's sanctioned route instead.",
    env: [
      { name: 'OPENAI_API_KEY', shape: 'an API key from https://platform.openai.com/api-keys', purpose: 'instead of a ChatGPT / Codex sign-in (or Azure OpenAI: level 5)' },
      { name: 'ANTHROPIC_API_KEY', shape: 'an API key from https://console.anthropic.com', purpose: 'instead of a Claude.ai sign-in (or Bedrock / Vertex AI: level 5)' },
      { name: 'GOOGLE_GENAI_API_KEY', shape: 'an API key from https://aistudio.google.com (free tier)', purpose: 'instead of a Gemini CLI sign-in (or Vertex AI: level 5)' },
    ],
    confirm: 'the provider you chose shows a ✓; nothing reads a subscription sign-in.',
    runs: () => ['as level 2 (one key) or level 5 (cloud platform)'],
    first: {
      package: [init('package', 'research_brief'), chat('package', 'research_brief')],
      clone: ['npm run chat:syndicate'],
    },
    notes: [
      'Anthropic: Claude.ai (Pro/Max) OAuth is for Claude Code and its own apps; third-party developers may not offer Claude.ai login or route requests through those credentials. Use an API key, Bedrock or Vertex AI.',
      "Google: reaching Gemini CLI's services with its sign-in from third-party software is against Gemini CLI's terms. Use an AI Studio key or Vertex AI.",
      "OpenAI: an API key or Azure OpenAI. OpenAI's Sign in with ChatGPT plan-usage flow is a documented preview for open-source, locally hosted apps; the engine does not implement it, and reusing the Codex CLI's own token is not that flow.",
      'A coding agent signed in with a subscription (Claude Code, Codex, Gemini CLI) can still drive this repository: the sign-in pays for the coding agent, and the engine runs on the keys above.',
    ],
    skill: 'melchizedek-onboard-keys',
    detectable: false,
  },
];

export function levelById(id: string): Level | undefined {
  return LEVELS.find((l) => l.id === id);
}

/** Every variable name the guides mention. */
export function guideEnvNames(): string[] {
  return [...new Set(LEVELS.flatMap((l) => l.env.map((e) => e.name)))].sort();
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** One level's startup guide, as Markdown (the terminal prints the same text). */
export function renderGuide(level: Level, form: CommandForm, shipped: ShippedIndex = shippedIndex()): string {
  const n = LEVELS.indexOf(level) + 1;
  const out: string[] = [];
  out.push(`## ${n}. ${level.title}`, '', level.summary, '');
  out.push(level.detectable ? '**Set in `.env`** (names and shapes only; you type the values yourself):' : '**Use instead** (names and shapes only):', '');
  out.push('| Variable | Shape | What it does |', '|---|---|---|');
  for (const e of level.env) out.push(`| \`${e.name}\` | ${e.shape} | ${e.purpose} |`);
  out.push('');
  out.push(`**Confirm:** \`${CMD.doctor[form]}\`: ${level.confirm}`, '');
  out.push('**Runs at this level:**', '');
  for (const r of level.runs(shipped)) out.push(`- ${r}`);
  out.push('', '**First commands:**', '', '```bash', ...level.first[form], '```', '');
  if (level.notes.length) {
    out.push('**Notes:**', '');
    for (const note of level.notes) out.push(`- ${note}`);
    out.push('');
  }
  out.push(`**Onboarding skill:** \`${level.skill}\` (\`${CMD.setup[form]} --level ${level.id}\` prints this guide)`);
  return out.join('\n');
}

/** The menu: one numbered line per level. */
export function renderMenu(): string {
  return LEVELS.map((l, i) => `  ${String(i + 1).padStart(2)}. ${l.menu}  [${l.id}]`).join('\n');
}

/** ONBOARDING.md, generated in full from the levels (package spelling). */
export function renderOnboardingDoc(shipped: ShippedIndex = shippedIndex()): string {
  const head = [
    '<!-- Generated by lib/onboarding.ts: `npm run setup -- --markdown > ONBOARDING.md`. Do not edit by hand; tests/onboarding.test.ts holds this file equal to the generator. -->',
    '',
    '# Onboarding: start from what you have',
    '',
    'Start with `npx melchizedek-setup` (in a clone, `npm run setup`). It opens a menu of the levels below and prints the guide for the one you pick; `--auto` reads your environment, names only, and prints the guide for the highest level it detects. Every guide lists variable names and shapes, never values: you type the values into `.env` yourself.',
    '',
    'In a clone, the commands are spelled as npm scripts (`npm run doctor`, `npm run chat:syndicate -- --syndicate <name>`); the menu prints that spelling there.',
    '',
    '| # | You have | Guide |',
    '|---|---|---|',
    ...LEVELS.map((l, i) => `| ${i + 1} | ${l.menu} | \`--level ${l.id}\` |`),
  ].join('\n');
  return `${[head, ...LEVELS.map((l) => renderGuide(l, 'package', shipped))].join('\n\n')}\n`;
}

// ── Detection (the doctor's, read) ───────────────────────────────────────────

export interface LevelDetection {
  id: LevelId;
  detected: boolean;
  /** Names and set/unset only. */
  evidence: string;
  /** The doctor's problems for this level, by variable name. */
  problems: string[];
}

/**
 * Which levels the environment is set up for, read from the doctor's result.
 * Local is always available (whether Ollama is running is not checked).
 */
export function detectLevels(result: DoctorResult): LevelDetection[] {
  const direct = result.providers.filter((p) => p.platform === 'direct' && p.funded && p.transport === 'direct');
  const names = direct.map((p) => `${p.label} (${p.keyEnv})`);
  const cloud = result.endpoints.filter((e) => e.platform === 'vertex' || e.platform === 'bedrock' || e.platform === 'azure' || e.platform === 'invalid');
  const serving = result.serving;
  const knownGateway = !!result.gateway && Object.prototype.hasOwnProperty.call(GATEWAYS, result.gateway.id);
  const oauthSet = result.oauth ? Object.entries(result.oauth.set).filter(([, on]) => on).map(([n]) => n) : [];
  const out: Record<Exclude<LevelId, 'subscription-signin'>, Omit<LevelDetection, 'id'>> = {
    local: { detected: true, evidence: 'always available; needs Ollama running (not checked)', problems: [] },
    'one-provider': {
      detected: direct.length >= 1,
      evidence: direct.length ? `direct key set: ${names.join(', ')}` : 'no provider key set',
      problems: [],
    },
    'several-providers': {
      detected: direct.length >= 2,
      evidence: `${direct.length} provider key(s) set`,
      problems: [],
    },
    gateway: {
      detected: !!result.gateway?.usable,
      // An unknown MODEL_GATEWAY value is never echoed (the doctor's own line quotes it).
      evidence: !result.gateway
        ? `${GATEWAY_ENV} unset`
        : knownGateway
          ? `${GATEWAY_ENV} set (${result.gateway.label}), ${GATEWAY_KEY_ENV} ${result.gateway.usable ? 'set' : 'unset'}`
          : `${GATEWAY_ENV} set to an unknown gateway`,
      problems: !result.gateway?.problem ? [] : knownGateway ? [result.gateway.problem] : [`${GATEWAY_ENV} must be one of ${Object.keys(GATEWAYS).join(', ')}`],
    },
    'cloud-platform': {
      detected: cloud.length > 0,
      evidence: cloud.length ? cloud.map((e) => e.label).join(', ') : 'no provider on a cloud platform',
      problems: cloud.flatMap((e) => e.problems),
    },
    byok: {
      detected: serving?.keyMode === 'byok',
      evidence: `A2A_KEY_MODE=${serving?.keyMode ?? 'server'}`,
      problems: [],
    },
    'caller-tokens': {
      detected: !!serving?.authDeclared,
      evidence: serving ? `A2A_AUTH=${serving.auth}${serving.authDeclared ? '' : ' (default)'}, A2A_SERVER_SECRET ${serving.set.A2A_SERVER_SECRET ? 'set' : 'unset'}` : 'no serving variable set',
      problems: serving?.problems ?? [],
    },
    'oauth-grants': {
      detected: oauthSet.length > 0,
      evidence: oauthSet.length ? `set: ${oauthSet.join(', ')}` : `${CREDENTIAL_KEY_ENV} unset`,
      problems: result.oauth?.problems ?? [],
    },
  };
  return LEVELS.filter((l) => l.detectable).map((l) => ({ id: l.id, ...out[l.id as Exclude<LevelId, 'subscription-signin'>] }));
}

/** The highest detected level (the last in menu order). */
export function highestLevel(detections: LevelDetection[]): Level {
  const hit = [...detections].reverse().find((d) => d.detected);
  return levelById(hit?.id ?? 'local')!;
}

/** `--auto`: what the environment has (names only), then the guide for the highest level. */
export function renderAuto(result: DoctorResult, form: CommandForm, shipped: ShippedIndex = shippedIndex()): string {
  const detections = detectLevels(result);
  const top = highestLevel(detections);
  const lines = ['melchizedek setup --auto: what this environment has (variable names only; no value is read out)', ''];
  for (const d of detections) {
    const n = LEVELS.findIndex((l) => l.id === d.id) + 1;
    lines.push(`  ${d.detected ? '✓' : '·'} ${String(n).padStart(2)}. ${d.id.padEnd(18)} ${d.evidence}`);
    for (const p of d.problems) lines.push(`        ✗ ${p}`);
  }
  lines.push('', `Highest level detected: ${LEVELS.indexOf(top) + 1}. ${top.title}`, '', renderGuide(top, form, shipped));
  return lines.join('\n');
}

// ── Writing .env ─────────────────────────────────────────────────────────────

export type EnvWriteResult =
  | { status: 'written'; path: string; added: string[] }
  | { status: 'exists'; path: string }
  | { status: 'not-ignored'; path: string; reason: string }
  | { status: 'no-template'; path: string };

/** True when git confirms `.env` in `cwd` is ignored (exit 0 from `git check-ignore`). */
export function gitIgnoresEnv(cwd: string): { ignored: boolean; reason: string } {
  const r = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd, stdio: 'ignore' });
  if (r.status === 0) return { ignored: true, reason: 'git check-ignore: .env is ignored' };
  if (r.status === 1) return { ignored: false, reason: '.env is not ignored by git here: add `.env` to .gitignore first' };
  return { ignored: false, reason: 'git check-ignore could not confirm .env is ignored (not a git repository, or git is missing): run `git init` and add `.env` to .gitignore first' };
}

/**
 * Create `.env` from `.env.example` for a level: the template verbatim, then
 * every name the level lists that the template does not already assign, left
 * blank. Never overwrites, never writes a value, and refuses unless git
 * confirms `.env` is ignored. The file is created mode 600.
 */
export function writeEnvForLevel(
  level: Level,
  opts: { cwd?: string; root?: string; checkIgnored?: (cwd: string) => { ignored: boolean; reason: string } } = {},
): EnvWriteResult {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const target = join(cwd, '.env');
  if (existsSync(target)) return { status: 'exists', path: target };
  const ignore = (opts.checkIgnored ?? gitIgnoresEnv)(cwd);
  if (!ignore.ignored) return { status: 'not-ignored', path: target, reason: ignore.reason };
  const source = join(opts.root ?? packageRoot(), '.env.example');
  if (!existsSync(source)) return { status: 'no-template', path: target };
  const template = readFileSync(source, 'utf-8');
  const assigned = new Set(
    template.split(/\r?\n/).map((l) => l.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1]).filter((n): n is string => !!n),
  );
  const added = level.env.map((e) => e.name).filter((n) => !assigned.has(n));
  const block = added.length
    ? `\n# ── Chosen with melchizedek-setup: ${level.title} ──\n# Names only; fill in the values yourself (shapes: ONBOARDING.md, level ${LEVELS.indexOf(level) + 1}).\n${added.map((n) => `${n}=`).join('\n')}\n`
    : '';
  writeFileSync(target, template.endsWith('\n') ? template + block : `${template}\n${block}`, { mode: 0o600, flag: 'wx' });
  chmodSync(target, 0o600);
  return { status: 'written', path: target, added };
}
