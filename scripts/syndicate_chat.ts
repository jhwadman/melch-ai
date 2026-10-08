#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSyndicate, parseCliBindings } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { isDispatchSyndicate } from '../lib/dispatch.ts';
import { approvalResponsePart, describeApproval, describeInput, ingestTurnMemory, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { PendingApproval } from '../lib/runtime/syndicateTurn.ts';

import { getFunctionCalls, getFunctionResponses } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { SessionService } from '../lib/runtime/sessions.ts';
import type { MemoryService } from '../lib/runtime/memoryService.ts';
import { runtimeSetting } from '../lib/runtime/runtimeFlag.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../lib/loadEnv.ts';

// ── Model routing ─────────────────────────────────────────────────────────────
// A model id resolves when an agent first calls it (lib/models/registry.ts),
// after loadEnv() has read the keys from .env.
import {
	providerForModel,
	providerKeyPresent,
	PROVIDERS,
} from '../lib/models/registry.ts';
import type { ProviderId } from '../lib/models/registry.ts';

// ── Persistence Factory ───────────────────────────────────────────────────────
// Supabase-specific initialization lives in supabaseProvider.ts.
import {
	hasSupabaseCredentials,
	createSupabaseServices,
} from '../lib/persistence/supabaseProvider.ts';

// The engine's level: no INFO chatter in the chat.
setLogLevel('warn');

const c = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	cyan: '\x1b[36m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	magenta: '\x1b[35m',
	red: '\x1b[31m',
};

// ── Persistence Mode Detection ────────────────────────────────────────────
// Which services the syndicate's memory_system asks for, given the
// credentials present:
//   1. long-term     — Supabase sessions + pgvector memory
//   2. session-only  — Supabase sessions, no long-term memory
//   3. internal-only — process memory (also the fallback without credentials)
// The user sees which mode is active in the startup banner.

interface PersistenceConfig {
	sessionService: 'supabase' | 'in-memory';
	memoryService: 'supabase-vector' | 'none';
}

function detectPersistenceConfig(memorySystem?: 'internal-only' | 'session-only' | 'long-term'): PersistenceConfig {
	// WHY: Credential detection is delegated to the persistence factory so that
	// the same logic governs both detection here and initialization below.
	const supabaseAvailable = hasSupabaseCredentials();
	const hasGeminiKey = !!(process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY);

	if (!memorySystem) {
		return {
			sessionService: supabaseAvailable ? 'supabase' : 'in-memory',
			memoryService: supabaseAvailable && hasGeminiKey ? 'supabase-vector' : 'none',
		};
	}

	let sessionService: 'supabase' | 'in-memory' = 'in-memory';
	let memoryService: 'supabase-vector' | 'none' = 'none';

	if (memorySystem === 'session-only' || memorySystem === 'long-term') {
		sessionService = supabaseAvailable ? 'supabase' : 'in-memory';
		if (!supabaseAvailable) console.warn(`\n${c.yellow}⚠ Requested ${memorySystem} memory system but missing Supabase credentials. Falling back to in-memory sessions.${c.reset}`);
	}

	if (memorySystem === 'long-term') {
		memoryService = supabaseAvailable && hasGeminiKey ? 'supabase-vector' : 'none';

		if (!hasGeminiKey) console.warn(`\n${c.yellow}⚠ Requested long-term memory system but missing Gemini API Key. Falling back to no long-term memory.${c.reset}`);
	}

	return { sessionService, memoryService };
}


function banner(
	config: SyndicateYamlConfig,
	persistence: PersistenceConfig,
	bindings: Record<string, unknown> = {},
	sessionId?: string
): void {
	console.log('');
	console.log(`${c.cyan}${c.bold}  ╔══════════════════════════════════════╗${c.reset}`);
	console.log(`${c.cyan}${c.bold}  ║        Melchizedek Syndicate         ║${c.reset}`);
	console.log(`${c.cyan}${c.bold}  ╚══════════════════════════════════════╝${c.reset}`);
	console.log(`${c.dim}  Syndicate    : ${c.yellow}${config.syndicate_name}${c.reset}`);
	console.log(`${c.dim}  Orchestrator : ${c.yellow}${config.orchestrator.name} (${config.orchestrator.model})${c.reset}`);
	const subagentNames = config.subagents.filter(s => s.name).map(s => s.name);
	if (subagentNames.length > 0) {
		console.log(`${c.dim}  Subagents    : ${c.yellow}${subagentNames.join(', ')}${c.reset}`);
	}
	const keys = Object.keys(bindings);
	if (keys.length > 0) {
		const bindStr = keys.map(k => `${k}=${bindings[k]}`).join(', ');
		console.log(`${c.dim}  Bindings     : ${c.magenta}${bindStr}${c.reset}`);
	}

	// Persistence indicators
	const sessionLabel = persistence.sessionService === 'supabase'
		? `${c.green}Supabase Postgres${c.reset}`
		: `${c.yellow}In-Memory${c.reset}`;
	const memoryLabel = persistence.memoryService === 'supabase-vector'
		? `${c.green}Supabase Vector Search (semantic)${c.reset}`
		: `${c.yellow}None${c.reset}`;
	console.log(`${c.dim}  Sessions     : ${sessionLabel}`);
	console.log(`${c.dim}  Memory       : ${memoryLabel}`);

	if (sessionId) {
		const sessionMode = persistence.sessionService === 'supabase' ? 'persistent' : 'in-memory';
		console.log(`${c.dim}  Session ID   : ${c.green}${sessionId}${c.reset} ${c.dim}(${sessionMode}, multi-turn)${c.reset}`);
	}
	console.log(`${c.dim}  Type         : ${c.green}"exit"${c.dim} to end the session${c.reset}`);
	console.log('');
}

async function main(): Promise<void> {
	loadEnv(import.meta.url);
	// Interactive chat is for reading the agent, not its telemetry: the
	// [OTEL_SPAN_JSON] lines are off here unless OTEL_CONSOLE_SPANS is set
	// (in .env, which loadEnv() has just read, or in the shell). Spans still
	// reach the in-process listeners and the Supabase sink either way.
	if (process.env.OTEL_CONSOLE_SPANS === undefined) process.env.OTEL_CONSOLE_SPANS = 'false';


	// MELCHIZEDEK_RUNTIME=adk (removed in 1.0.0) stops the chat here, naming the release.
	runtimeSetting();

	const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
	if (apiKey) {
		process.env.GEMINI_API_KEY = apiKey;
	}
	// The key requirement is enforced AFTER the syndicate loads: a syndicate
	// whose every agent is an open-weight ollama/* model needs no key at all.

	// ── Parse --syndicate flag ────────────────────────────────
	// WHY: Allows invoking any syndicate config without editing code.
	// Usage: npm run chat:syndicate -- --syndicate critic
	// Defaults to 'syndicate.yaml' for backwards compatibility.
	let syndicateFile = 'syndicate.yaml';
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--syndicate' && i + 1 < argv.length) {
			const name = argv[i + 1];
			syndicateFile = name.endsWith('.yaml') ? name : `${name}.yaml`;
			break;
		}
	}

	// ONLY what the caller actually asked for on the command line.
	//
	// WHY nothing is seeded here: loadSyndicate merges these OVER a syndicate's
	// own `variables:` block, so a hardcoded default is not a fallback — it is
	// an override applied to every syndicate. `headline_count: 3` used to ride
	// along into unrelated agents (a Tutor turn announced it in the banner and
	// recorded it in syndicate.bindings telemetry) while silently beating the
	// 5 that syndicate.yaml declares for itself. Universal tokens belong to
	// defaultBindings() in lib/loadSyndicate.ts, which the loader applies UNDER
	// the YAML — that is where current_date lives, timezone-pinned.
	const mergedBindings = parseCliBindings(argv);

	// Load the syndicate definition
	const config = loadSyndicate(syndicateFile, {
		bindings: mergedBindings,
	});

	// ── Enforce the key requirement per declared provider ────────────────────
	// WHY: An all-ollama/* syndicate runs entirely on the user's machine, so
	// demanding any cloud key would be an artificial gate. Each cloud model in
	// the graph requires ITS provider's key: claude-* → ANTHROPIC_API_KEY,
	// gpt-* → OPENAI_API_KEY, grok-* → XAI_API_KEY, gemini-* (or no model,
	// the default model) → the Gemini key. Gemini-backed tools (google_search /
	// generate_image / long-term memory embeddings) still need the Gemini key
	// regardless of the inference model, and fail with a clear API error.
	const declaredModels = [
		config.orchestrator.model,
		...config.subagents.map((s) => s.model),
	].filter((m): m is string => !!m);
	const requiredProviders = new Set<ProviderId>(
		declaredModels.length > 0
			? declaredModels.map((m) => providerForModel(m))
			: ['gemini'], // no model declared anywhere → the Gemini default
	);
	if (!config.orchestrator.model) requiredProviders.add('gemini');
	const missingKeys = [...requiredProviders].filter(
		(p) => !providerKeyPresent(p),
	);
	if (missingKeys.length > 0) {
		for (const p of missingKeys) {
			console.error(
				`${c.yellow}⚠ ${PROVIDERS[p].label} requires ${PROVIDERS[p].keyEnv}, which is not set.${c.reset}`,
			);
		}
		console.error(`${c.dim}  (Only syndicates whose every agent uses an ollama/* model run keyless.)${c.reset}`);
		process.exit(1);
	}

	// Generate stable session identifiers upfront so the banner can display them.
	// Memory/session silo for the local CLI. Override with MELCHIZEDEK_USER_ID
	// when testing per-user isolation (e.g. long-term memory for two different
	// people) — otherwise every CLI session shares the 'local-user' bucket.
	const SESSION_USER_ID = process.env.MELCHIZEDEK_USER_ID?.trim() || 'local-user';
	const SESSION_ID = randomUUID();

	// Live token-by-token output. Off gives one block per turn — useful when
	// piping a transcript, or for an agent whose reply is structured JSON.
	const STREAM_REPLIES = process.env.CHAT_STREAMING !== 'false';

	// ── Detect persistence mode ──────────────────────────────────────────────
	const persistence = detectPersistenceConfig(config.memory_system);

	// ── Persistence ───────────────────────────────────────────────────────────
	// The same services the server would use for this syndicate's
	// memory_system: Supabase sessions (and the memory service for
	// long-term) when configured, process memory otherwise.
	// The engine's stores (ADR 0080, ADR 0107): the in-process one, or Supabase's.
	let sessionService: SessionService = new InProcessSessionService();
	let memoryService: MemoryService | undefined;
	if (persistence.sessionService === 'supabase') {
		const services = await createSupabaseServices({
			// Empty only when an all-local syndicate runs keyless — then
			// detectPersistenceConfig has already left the memory service off.
			apiKey: apiKey ?? '',
			withMemory: persistence.memoryService === 'supabase-vector',
		});
		sessionService = services.sessionService;
		memoryService = services.memoryService;
	}

	const appName = config.syndicate_name || 'melchizedek-syndicate';
	await sessionService.create({ appName, userId: SESSION_USER_ID, sessionId: SESSION_ID, state: {} });
	const turnSessions = sessionService;
	const turnMemory = memoryService;
	banner(config, persistence, mergedBindings, SESSION_ID);

	// Plan-dispatch, nested yaml_reference syndicates, guards and the
	// max_steps cap run here exactly as the A2A server runs them: both call
	// lib/runtime/syndicateTurn.ts. (This file used to build its own graph
	// and silently ran dispatch syndicates in DELEGATE mode.)
	if (isDispatchSyndicate(config)) {
		console.log(`${c.dim}  Mode         : plan-dispatch (classifier → one route answers)${c.reset}\n`);
	}

	// Strip --bind/--bindings/--syndicate pairs AND bare '--' separators from
	// argv to get the actual user query. The bare '--' leaks in when npm passes
	// the named syndicate shortcuts (e.g. syndicate:image) to the node process.
	const rawArgs = process.argv.slice(2);
	const queryParts: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		if (rawArgs[i] === '--') continue; // drop bare separator
		if ((rawArgs[i] === '--bind' || rawArgs[i] === '--bindings' || rawArgs[i] === '--syndicate') && i + 1 < rawArgs.length) {
			i++; // skip the value
		} else {
			queryParts.push(rawArgs[i]);
		}
	}
	const cliInput = queryParts.join(' ');

	// Ctrl+C during a turn cancels the turn; Ctrl+C at the prompt exits.
	let activeTurn: AbortController | undefined;

	/** A gated call waiting for this person's yes (ADR 0028); answered by the next prompt. */
	let pendingApproval: PendingApproval | undefined;

	async function runChat(trimmed: string, parts: Array<Record<string, unknown>> = [{ text: trimmed }]) {
		const printer = makePrinter();
		activeTurn = new AbortController();
		try {
			const result = await runSyndicateTurn({
				config,
				parts,
				appName,
				userId: SESSION_USER_ID,
				sessionId: SESSION_ID,
				sessionService: turnSessions,
				memoryService: turnMemory,
				compile: {
					onUnknownTool: (name) => console.warn(`${c.yellow}⚠ Unknown tool: '${name}' — skipping.${c.reset}`),
					log: (message) => console.log(`${c.dim}  ${message}${c.reset}`),
				},
				// SSE makes the adapters emit display-only partials as tokens
				// land, so thinking and the reply appear as they are produced.
				streaming: STREAM_REPLIES,
				signal: activeTurn.signal,
				trace: { bindings: mergedBindings },
				events: {
					onEvent: printer.onEvent,
					onProgress: (text) => {
						if (text.startsWith('Routed to') || text.startsWith('Guard ')) console.log(`\n${c.dim}[${text}]${c.reset}`);
					},
				},
			});
			printer.finish();
			if (result.relayFallback) {
				// The orchestrator's relay came back empty; show what shipped.
				console.log(`\n${c.dim}[relay fallback — the specialist's answer]${c.reset}\n${result.text}`);
			}
			if (result.status === 'input-required' && result.approval) {
				// The turn stopped on a tool a person must approve: a gated tool,
				// or a skill script. The next prompt asks for the decision.
				pendingApproval = result.approval;
				console.log(`\n${c.yellow}⏸ Approval needed: ${describeApproval(result.approval)}${c.reset}`);
			} else if (result.status === 'input-required' && result.input) {
				// A workflow's ask_user node: whatever is typed next is the answer,
				// and the graph resumes from that node.
				console.log(`\n${c.yellow}❓ ${describeInput(result.input)}${c.reset}\n${c.dim}  (your next message is the answer)${c.reset}`);
			} else if (result.status !== 'completed') {
				console.error(`\n${c.yellow}⚠ [${result.error?.code ?? 'ERROR'}] ${result.error?.message ?? ''}${c.reset}`);
			}
			console.log('\n');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`\n${c.yellow}⚠ Error: ${msg}${c.reset}\n`);
		} finally {
			activeTurn = undefined;
		}
	}

	const ingest = async () => {
		if (!turnMemory) return;
		try {
			const ingested = await ingestTurnMemory({
				memoryService: turnMemory,
				sessionService: turnSessions,
				appName,
				userId: SESSION_USER_ID,
				sessionId: SESSION_ID,
				extractionRules: config.memory_extraction_rules,
				extractionModel: config.memory_extraction_model,
			});
			console.log(ingested
				? `${c.green}  ✓ Session ingested into long-term memory.${c.reset}`
				: `${c.dim}  No session data to ingest.${c.reset}`);
		} catch (err: unknown) {
			console.error(`${c.yellow}  ⚠ Memory ingestion failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
		}
	};

	if (cliInput) {
		console.log(`${c.green}${c.bold}You${c.reset} › ${cliInput}`);
		await runChat(cliInput);
		if (pendingApproval) {
			// A one-shot run has nobody to ask: the call stays unapproved and
			// never runs. Interactive mode, or an A2A client, can answer it.
			console.error(`${c.yellow}⚠ The run stopped on a call that needs your approval; it did not run. Start the chat without a query to approve or refuse such calls.${c.reset}`);
			process.exitCode = 2;
		}
		// A one-shot query still contributes to long-term memory.
		await ingest();
		return;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = (): void => {
		if (pendingApproval) {
			const approval = pendingApproval;
			rl.question(`${c.yellow}${c.bold}Approve${c.reset} ${describeApproval(approval)}? [y/N] › `, async (answer: string) => {
				pendingApproval = undefined;
				const approved = /^y(es)?$/i.test(answer.trim());
				console.log(`${c.dim}  ${approved ? 'Approved' : 'Refused'}: ${approval.agent} → ${approval.tool}${c.reset}`);
				await runChat(approved ? 'approve' : 'reject', [approvalResponsePart(approval.id, approved)]);
				ask();
			});
			return;
		}
		rl.question(`${c.green}${c.bold}You${c.reset} › `, async (userInput: string) => {
			const trimmed = userInput.trim();
			if (!trimmed) { ask(); return; }

			if (['exit', 'quit', 'bye'].includes(trimmed.toLowerCase())) {
				// Session end is where the conversation becomes long-term memory.
				console.log(`\n${c.dim}  Ingesting session into long-term memory...${c.reset}`);
				await ingest();
				console.log(`${c.cyan}  Goodbye! 👋${c.reset}\n`);
				rl.close();
				return;
			}

			await runChat(trimmed);
			ask();
		});
	};

	process.on('SIGINT', async () => {
		if (activeTurn) {
			console.log(`\n${c.dim}  Canceling the turn...${c.reset}`);
			activeTurn.abort();
			return;
		}
		console.log(`\n${c.dim}  Intercepted exit signal. Ingesting session into long-term memory...${c.reset}`);
		await ingest();
		console.log(`${c.cyan}  Goodbye! 👋${c.reset}\n`);
		process.exit(0);
	});

	ask();
}

/**
 * Prints a turn's events as they arrive: tool calls, thinking (dimmed), the
 * reply streamed token by token, and inline images saved to outputs/.
 *
 * Under SSE the reply arrives as partials and is then REPEATED whole on the
 * final event (the one the store keeps in session history): show the partials,
 * skip the repeat.
 */
function makePrinter() {
	let currentMode: 'thinking' | 'text' | 'none' = 'none';
	let streamedText = false;
	// Which agent the current text label names: a workflow's nodes speak in
	// turn, each under its own label.
	let labelled = '';
	return {
		onEvent(event: TurnEvent) {
			const e = event as any;
			const isPartial = e.partial === true;
			for (const call of getFunctionCalls(event) ?? []) {
				if (call.name === 'transfer_to_agent') {
					console.log(`\n${c.dim}[${e.author} is delegating to subagent: ${JSON.stringify(call.args)}]${c.reset}`);
				} else {
					console.log(`\n${c.dim}[${e.author} is calling tool: ${call.name}]${c.reset}`);
				}
				currentMode = 'none';
			}
			for (const response of getFunctionResponses(event) ?? []) {
				console.log(`\n${c.dim}[Received response from: ${response.name}]${c.reset}`);
				currentMode = 'none';
			}
			for (const part of event.content?.parts ?? []) {
				const p = part as any;
				if (p.thought) {
					if (currentMode !== 'thinking') {
						console.log(`\n${c.cyan}✦ ${e.author} is thinking...${c.reset}`);
						currentMode = 'thinking';
					}
					process.stdout.write(c.dim + p.text + c.reset);
				} else if (p.text) {
					if (!isPartial && streamedText) continue;
					if (currentMode !== 'text' || labelled !== e.author) {
						process.stdout.write(`\n${c.magenta}${c.bold}${e.author}${c.reset} › `);
						currentMode = 'text';
						labelled = e.author;
					}
					process.stdout.write(p.text);
					if (isPartial) streamedText = true;
				} else if (p.inlineData) {
					// Image models return base64 inlineData; save it as a file.
					const { mimeType, data } = p.inlineData;
					const ext = mimeType?.split('/')[1] ?? 'png';
					const outputDir = join(process.cwd(), 'outputs');
					mkdirSync(outputDir, { recursive: true });
					const filename = `image_${Date.now()}.${ext}`;
					writeFileSync(join(outputDir, filename), Buffer.from(data, 'base64'));
					process.stdout.write(`\n${c.green}✓ Image saved → outputs/${filename}${c.reset}\n`);
				}
			}
			// A complete event ends that agent's turn; the next starts fresh.
			if (!isPartial) streamedText = false;
		},
		finish() {
			currentMode = 'none';
		},
	};
}

main().catch((err) => {
	if (err.code !== 'ERR_USE_AFTER_CLOSE') {
		console.error(err);
		process.exit(1);
	}
});
