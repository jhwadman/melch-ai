/**
 * lib/envSyndicate.ts — a syndicate handed to the server in the environment.
 *
 * A container started from the published server image has no agents
 * directory of its own and, without a database, no registry to load from.
 * `MELCHIZEDEK_AGENT_YAML` carries the whole syndicate file, base64-encoded
 * (`base64 < agent.yaml`), so a host that only takes environment variables
 * can still run one. `MELCHIZEDEK_AGENT_ID` names it (default `agent`): the
 * id callers address at `/<id>/` and list in `A2A_SERVED_AGENTS`.
 *
 * The file is written into a fresh private directory (0700, the file 0600)
 * that becomes the agents directory, then loaded once, so a bad definition
 * stops the boot instead of failing the first request. Nested
 * `yaml_reference`s have no files to load from here: each must be carried in
 * the definition's own `bundled_references`, as a registry
 * version carries them, or the boot names the missing ones.
 *
 * Imports only node built-ins and lib/loadSyndicate.ts.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSyndicate } from './loadSyndicate.ts';

/** The id a syndicate from the environment is served under unless MELCHIZEDEK_AGENT_ID says otherwise. */
export const ENV_AGENT_ID = 'agent';

/** Same charset as an A2A agent id (lib/a2a/app.ts isValidAgentId), without `:` and `.`, which name registry rows and files. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export interface EnvSyndicate {
  /** The private directory the file was written to; the server's agents directory. */
  agentsDir: string;
  /** The served id. */
  id: string;
  /** `<id>.yaml`, the default syndicate's file name. */
  file: string;
}

/**
 * The syndicate in `MELCHIZEDEK_AGENT_YAML`, written to disk and checked, or
 * undefined when the variable is unset. Throws naming the variable and, for
 * a definition that does not load, the loader's own reason.
 */
export function envSyndicate(env: NodeJS.ProcessEnv = process.env, parent: string = tmpdir()): EnvSyndicate | undefined {
  const encoded = env.MELCHIZEDEK_AGENT_YAML?.replace(/\s+/g, '');
  if (!encoded) return undefined;
  const id = env.MELCHIZEDEK_AGENT_ID?.trim() || ENV_AGENT_ID;
  if (!AGENT_ID.test(id)) {
    throw new Error('MELCHIZEDEK_AGENT_ID must be 1-120 letters, digits, _ or -.');
  }
  if (env.MELCHIZEDEK_AGENTS_DIR?.trim()) {
    throw new Error('MELCHIZEDEK_AGENT_YAML and MELCHIZEDEK_AGENTS_DIR are both set: the syndicate comes from one place. Unset one of them.');
  }
  // Node's base64 decoder takes the URL-safe alphabet too.
  const bytes = BASE64.test(encoded) ? Buffer.from(encoded, 'base64') : undefined;
  if (!bytes?.length) {
    throw new Error('MELCHIZEDEK_AGENT_YAML must be the syndicate file base64-encoded (base64 < agent.yaml), not the YAML itself.');
  }

  const agentsDir = mkdtempSync(join(parent, 'melchizedek-agent-'));
  const file = `${id}.yaml`;
  writeFileSync(join(agentsDir, file), bytes, { mode: 0o600 });

  let config;
  try {
    config = loadSyndicate(file, { agentsDir, shippedFallback: false });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MELCHIZEDEK_AGENT_YAML does not load: ${message}`);
  }
  const bundled = config.bundled_references ?? {};
  const missing = (config.subagents ?? [])
    .map((s) => s.yaml_reference)
    .filter((ref): ref is string => typeof ref === 'string' && !Object.hasOwn(bundled, ref));
  if (missing.length) {
    throw new Error(
      `MELCHIZEDEK_AGENT_YAML references nested syndicates it does not carry: ${missing.join(', ')}. `
        + 'Put each in the definition\'s bundled_references, or serve from the registry (A2A_REGISTRY_AGENTS).',
    );
  }
  return { agentsDir, id, file };
}
