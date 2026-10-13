/**
 * examples/capstone/agent.ts — the one server-side function the starter's
 * backend needs: send a visitor's question to the A2A agent service and turn
 * whatever comes back (an answer, a failed task, a refused credential, no
 * service at all) into either an answer or a failure a visitor can read.
 *
 * Plain fetch, no dependencies. The secret and the optional model key come
 * from the backend's own configuration and never leave this process except
 * as headers to the agent service.
 */

export interface AgentServiceConfig {
  /** The agent's JSON-RPC endpoint, e.g. http://127.0.0.1:4000/a2a/jsonrpc. */
  url: string;
  /** The A2A server's bearer secret (A2A_SERVER_SECRET); '' when the local server runs without one. */
  secret: string;
  /** A model key sent as X-API-Key, only for a server in BYOK mode; '' otherwise. */
  apiKey: string;
  /** Per-request wall clock in milliseconds. */
  timeoutMs: number;
}

export interface AskInput {
  /** The opaque account id the backend took from the visitor's session. Never from the browser. */
  userId: string;
  /** The full message text, already assembled by the backend. */
  text: string;
  /** One id per conversation; the agent service resumes the session it names. */
  contextId: string;
}

/** What a visitor may be shown when the service did not answer. */
export type FailureKind =
  | 'service_unavailable'
  | 'timeout'
  | 'service_refused'
  | 'busy'
  | 'service_error'
  | 'agent_failed';

export type AgentOutcome =
  | { ok: true; text: string; state: string; statusLines: string[] }
  | { ok: false; kind: FailureKind; httpStatus: number; message: string; detail: string };

/** The text a visitor reads for each failure. No internal detail, no secret, no URL. */
export const FAILURE_MESSAGES: Record<FailureKind, string> = {
  service_unavailable:
    'The event assistant is not available right now, so your question was not answered. Please try again in a few minutes.',
  timeout: 'The event assistant took too long to answer, so the request was stopped. Please try again.',
  service_refused:
    'The event assistant refused this website\'s request. This is a configuration problem on our side, not something you did.',
  busy: 'The event assistant is busy. Please wait a minute and try again.',
  service_error: 'The event assistant returned an error, so your question was not answered. Please try again.',
  agent_failed: 'The event assistant could not finish an answer to this question. Please try again, or ask it differently.',
};

const STATUS_FOR: Record<FailureKind, number> = {
  service_unavailable: 503,
  timeout: 504,
  service_refused: 502,
  busy: 503,
  service_error: 502,
  agent_failed: 502,
};

function failure(kind: FailureKind, detail: string): AgentOutcome {
  return { ok: false, kind, httpStatus: STATUS_FOR[kind], message: FAILURE_MESSAGES[kind], detail };
}

interface TextPart {
  kind?: string;
  text?: string;
}
interface A2AMessage {
  parts?: TextPart[];
}
interface A2ATask {
  status?: { state?: string; message?: A2AMessage };
  history?: A2AMessage[];
  artifacts?: Array<{ parts?: TextPart[] }>;
}

const partsText = (parts: TextPart[] | undefined) => (parts ?? []).map((p) => p.text ?? '').join('');

/** Removes every occurrence of `secret` from a string, for log lines. */
export function redact(text: string, ...secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}

/**
 * One message to the agent service. The three headers the course's project
 * teaches: the bearer secret, the end user's id (the memory and session
 * silo), and, only in BYOK mode, the model key.
 */
export async function askAgent(config: AgentServiceConfig, input: AskInput, fetchImpl: typeof fetch = fetch): Promise<AgentOutcome> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': input.userId,
  };
  if (config.secret) headers.Authorization = `Bearer ${config.secret}`;
  if (config.apiKey) headers['X-API-Key'] = config.apiKey;

  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        // contextId goes INSIDE message; beside it, the protocol ignores it.
        contextId: input.contextId,
        parts: [{ kind: 'text', text: input.text }],
      },
    },
  };

  let res: Response;
  try {
    res = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return failure('timeout', `no reply within ${config.timeoutMs} ms`);
    return failure('service_unavailable', `cannot reach the agent service: ${e?.cause?.code ?? e?.message ?? String(err)}`);
  }

  if (res.status === 401 || res.status === 403) {
    return failure('service_refused', `agent service answered HTTP ${res.status}: check that A2A_SERVER_SECRET matches the server's`);
  }
  if (res.status === 429) return failure('busy', 'agent service answered HTTP 429 (rate limit)');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return failure('service_error', `agent service answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let data: { result?: A2ATask; error?: { code?: number; message?: string } };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return failure('service_error', 'agent service answered with something that is not JSON');
  }
  if (data.error) return failure('service_error', `JSON-RPC error ${data.error.code ?? ''}: ${data.error.message ?? ''}`.trim());

  const task = data.result ?? {};
  const state = task.status?.state ?? 'unknown';
  const statusLines = (task.history ?? [])
    .map((m) => partsText(m.parts))
    .filter((t) => t.startsWith('[STATUS]'))
    .map((t) => t.slice('[STATUS]'.length).trim());
  const text = partsText(task.status?.message?.parts) || (task.artifacts ?? []).map((a) => partsText(a.parts)).join('');

  if (state === 'failed' || state === 'rejected' || state === 'canceled') {
    return failure('agent_failed', `task ${state}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return failure('agent_failed', `task ${state} with no text`);
  return { ok: true, text: text.trim(), state, statusLines };
}
