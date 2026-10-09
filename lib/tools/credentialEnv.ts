/**
 * lib/tools/credentialEnv.ts — which environment variables a YAML may name
 * as a credential, and the one way a credential is read from one.
 *
 * WHY this file exists:
 *   A syndicate YAML (possibly registry-stored) names both a variable and
 *   the host its value is sent to: an OpenAPI `auth` (bearer_env, api_key,
 *   oauth2), an MCP server's `mcp_auth.oauth2`. So a YAML may never name one
 *   of the framework's own secrets: the database URL, a provider key or an
 *   A2A secret cannot be sent to an API or a token endpoint.
 *   OPENAPI_CREDENTIAL_ENVS, when the operator sets it, is the exact list of
 *   variables any of these may name.
 *
 * A value is read here and handed to the code that sends it; an error names
 * the variable, never its value.
 */

/** Prefixes and names of variables the framework itself reads: never an API credential. */
const FRAMEWORK_ENV_PREFIXES = [
  'A2A_', 'SUPABASE_', 'DATABASE_', 'MCP_', 'MODEL_', 'MEMORY_', 'OTEL_', 'TELEMETRY_', 'MELCHIZEDEK_',
  'GOOGLE_', 'GEMINI_', 'ANTHROPIC_', 'OPENAI_', 'AZURE_', 'AWS_', 'XAI_', 'MOONSHOT_', 'OLLAMA_', 'WIKI_',
  'ALLOW_', 'OPENAPI_',
];
const FRAMEWORK_ENV_NAMES = new Set(['PUBLIC_URL', 'HOST', 'PORT', 'PATH', 'HOME', 'NODE_OPTIONS', 'WEB_EXTRACT_CHAR_LIMIT']);

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
 * The credential in `name`, trimmed. Throws when the allowlist refuses the
 * variable or it is not set; `where` prefixes the message, which names the
 * variable and never its value.
 */
export function readCredentialEnv(name: string, where: string, env: NodeJS.ProcessEnv = process.env): string {
  const refused = credentialEnvProblem(name, env);
  if (refused) throw new Error(`${where}: ${refused}`);
  const value = env[name]?.trim();
  if (!value) throw new Error(`${where}: ${name} is not set (auth reads it from the environment)`);
  return value;
}
