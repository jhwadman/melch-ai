/**
 * tests/helpers/isolateLocalState.ts — loaded before every test file
 * (`npm test` passes it with --import).
 *
 * A developer who signed in with ChatGPT on this machine has a credential at
 * ~/.melchizedek/chatgpt-signin.json, and with no OPENAI_API_KEY it would
 * carry OpenAI ids and stop every served surface (ADR 0126). The suite must
 * not depend on that: every test process
 * points the sign-in at a path that does not exist. Tests that exercise the
 * sign-in set their own file.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.MELCHIZEDEK_CHATGPT_SIGNIN_FILE = join(tmpdir(), `melch-test-no-chatgpt-signin-${process.pid}`, 'chatgpt-signin.json');
