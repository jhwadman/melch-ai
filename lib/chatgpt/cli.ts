/**
 * lib/chatgpt/cli.ts — the terminal side of Sign in with ChatGPT (ADR 0126),
 * shared by `melchizedek-setup --chatgpt-signin | --chatgpt-signout |
 * --chatgpt-status` and `melchizedek-chat --chatgpt-signin`.
 *
 * Prints the authorization link (it carries no secret: a one-time state and
 * a PKCE challenge), the file the credential lives in, and what the sign-in
 * now carries. Never a token.
 */

import { signIn, signOut } from './oauth.ts';
import type { OAuthOptions } from './oauth.ts';
import { CHATGPT_SIGNIN_ENV, chatGptSignInRoutesOpenAi, chatGptSignInStatus, servedSurface, signInFile } from './state.ts';

export interface ChatGptCliOptions extends OAuthOptions {
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  port?: number;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

/** The browser sign-in, from a terminal. Returns an exit code. */
export async function runChatGptSignIn(opts: ChatGptCliOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  const surface = servedSurface();
  if (surface) {
    log(`✗ ${surface} is a served surface; Sign in with ChatGPT is for your own machine only.`);
    return 1;
  }
  const file = signInFile(env);
  try {
    await signIn({
      file,
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      onUrl: (url) => log(`Opening your browser to sign in with ChatGPT. If it does not open, visit:\n\n  ${url}\n`),
    });
    log(`✓ Signed in with ChatGPT; your plan may be used for OpenAI requests (stored at ${file}, mode 600).`);
    log(
      chatGptSignInRoutesOpenAi(env)
        ? '  OpenAI model ids (gpt-*, o<digit>*) now run on it on this machine.'
        : env[CHATGPT_SIGNIN_ENV]?.trim().toLowerCase() === 'off'
          ? `  ${CHATGPT_SIGNIN_ENV}=off is set, so nothing uses it until you unset it.`
          : '  OPENAI_API_KEY (or another OpenAI endpoint) is set and wins; unset it to run OpenAI ids on the sign-in.',
    );
    log('  Local only: melchizedek-serve and melchizedek-worker refuse to start while it is the OpenAI path. Usage limits are your ChatGPT plan\'s.');
    return 0;
  } catch (err) {
    log(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Sign out: tokens removed locally, refresh token revoked at OpenAI. */
export async function runChatGptSignOut(opts: ChatGptCliOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const file = signInFile(opts.env ?? process.env);
  try {
    const r = await signOut(file, opts.issuer ? { issuer: opts.issuer } : {});
    if (!r.hadTokens) log(`· No ChatGPT sign-in was stored at ${file}.`);
    else if (r.revoked) log(`✓ Signed out: the tokens are removed from ${file} and revoked at OpenAI.`);
    else log(`✓ Signed out locally (${file}). OpenAI did not confirm the revocation: disconnect the app in ChatGPT's settings.`);
    return 0;
  } catch (err) {
    log(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Where the sign-in is, and whether it carries OpenAI ids here. */
export function runChatGptStatus(opts: ChatGptCliOptions = {}): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  const s = chatGptSignInStatus(env);
  if (s.problem) {
    log(`✗ ${s.problem}`);
    return 1;
  }
  log(`${s.signedIn ? '✓ signed in' : '· not signed in'} · ${s.file}${s.enabled ? '' : ` · ${CHATGPT_SIGNIN_ENV}=off`}`);
  if (s.signedIn) log(chatGptSignInRoutesOpenAi(env) ? '  carries OpenAI ids on this machine (local only)' : '  not used here: OPENAI_API_KEY or another OpenAI endpoint wins, or it is switched off');
  return 0;
}
