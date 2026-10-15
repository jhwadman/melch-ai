/**
 * lib/models/credentialSource.ts — where the engine reads a credential by
 * its environment variable name (ADR 0133).
 *
 * By default every provider key, gateway key and embedding key is read from
 * `process.env`. An embedding application that holds keys elsewhere (an OS
 * keychain, a secret manager) sets a source once:
 *
 *   setCredentialSource((name) => keychain.get(name));
 *
 * and every read below asks the source first, by the same names the
 * environment uses (ANTHROPIC_API_KEY, MODEL_GATEWAY_API_KEY, …), at the
 * moment of use: nothing is cached, so a key the user removes stops working
 * on the next call. A source that returns undefined for a name falls back to
 * the environment. A dependency-free leaf, so providerMap.ts stays one.
 */

/** Returns the credential held under an environment variable name, or undefined. Must not throw. */
export type CredentialSource = (name: string) => string | undefined;

let source: CredentialSource | undefined;

/** Sets (or, with undefined, clears) the process's credential source. */
export function setCredentialSource(next: CredentialSource | undefined): void {
  source = next;
}

/** The credential named `name`: the source's, else `env`'s. A source that throws counts as holding nothing. */
export function credentialValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (source) {
    try {
      const held = source(name);
      if (held !== undefined && held !== '') return held;
    } catch {
      /* a broken source must not take the engine down; the environment still answers */
    }
  }
  return env[name];
}

/**
 * `env` as the engine's env-reading helpers see it: a read by name asks the
 * source first. For functions that take an `env` parameter; enumeration and
 * spreading see only `env`'s own variables.
 */
export function credentialEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!source) return env;
  return new Proxy(env, {
    get(target, key, receiver) {
      return typeof key === 'string' ? credentialValue(key, target) : Reflect.get(target, key, receiver);
    },
  });
}
