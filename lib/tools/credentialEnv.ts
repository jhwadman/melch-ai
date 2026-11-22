/**
 * lib/tools/credentialEnv.ts — which environment variables a YAML may name
 * as a credential, and the one way a credential is read from one.
 *
 * WHY this file exists:
 *   A syndicate YAML (possibly registry-stored) names both a variable and
 *   the host its value is sent to: an OpenAPI `auth` (bearer_env, api_key,
 *   oauth2), an MCP server's `auth` (bearer_env, header, oauth2; ADR 0163). So a YAML may never name one
 *   of the framework's own secrets: the database URL, a provider key or an
 *   A2A secret cannot be sent to an API or a token endpoint.
 *   OPENAPI_CREDENTIAL_ENVS, when the operator sets it, is the exact list of
 *   variables any of these may name.
 *
 * A value is read here and handed to the code that sends it; an error names
 * the variable, never its value. Every read goes through the credential
 * source (lib/models/credentialSource.ts, ADR 0133): an embedding
 * application's keychain is asked by the variable's name first, then the
 * environment, exactly as for a provider key or an MCP `pass_env`.
 */

import { credentialValue } from '../models/credentialSource.ts';

/** Prefixes and names of variables the framework itself reads: never an API credential. */
const FRAMEWORK_ENV_PREFIXES = [
  'A2A_', 'SUPABASE_', 'DATABASE_', 'MCP_', 'MODEL_', 'MEMORY_', 'OTEL_', 'TELEMETRY_', 'MELCHIZEDEK_',
  'GOOGLE_', 'GEMINI_', 'ANTHROPIC_', 'OPENAI_', 'AZURE_', 'AWS_', 'XAI_', 'MOONSHOT_', 'DEEPSEEK_', 'TYPESAFE_', 'OLLAMA_', 'WIKI_',
  'ALLOW_', 'OPENAPI_',
];
const FRAMEWORK_ENV_NAMES = new Set(['PUBLIC_URL', 'HOST', 'PORT', 'PATH', 'HOME', 'NODE_OPTIONS', 'WEB_EXTRACT_CHAR_LIMIT', 'OAUTH_REDIRECT_URI', 'OAUTH_CALLBACK_IDENTITY']);

/**
 * Why an `auth` may not read this variable, or null. With
 * OPENAPI_CREDENTIAL_ENVS set, only the names it lists are allowed; without
 * it, anything but the framework's own variables is.
 */
export function credentialEnvProblem(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const allow = env.OPENAPI_CREDENTIAL_ENVS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (allow?.length) {
    return allow.includes(name) ? null : `${name} is not in OPENAPI_CREDENTIAL_ENVS (${allow.join(', ')})`;
  }
  if (FRAMEWORK_ENV_NAMES.has(name) || FRAMEWORK_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    return `${name} is one of the framework's own settings and may not be sent to an API; give the API its own variable (or list it in OPENAPI_CREDENTIAL_ENVS)`;
  }
  return null;
}

/**
 * The credential in `name`, trimmed, or undefined when it is not set: the
 * credential source's value first, then `env`'s. Undefined too when the
 * allowlist refuses the variable, so no read skips the rule.
 */
export function credentialEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (credentialEnvProblem(name, env)) return undefined;
  return credentialValue(name, env)?.trim() || undefined;
}

/**
 * The credential in `name`, trimmed: the credential source's value first,
 * then `env`'s. Throws when the allowlist refuses the variable or it is not
 * set; `where` prefixes the message, which names the variable and never its
 * value.
 */
export function readCredentialEnv(name: string, where: string, env: NodeJS.ProcessEnv = process.env): string {
  const refused = credentialEnvProblem(name, env);
  if (refused) throw new Error(`${where}: ${refused}`);
  const value = credentialEnvValue(name, env);
  if (!value) throw new Error(`${where}: ${name} is not set (auth reads it from the environment)`);
  return value;
}
