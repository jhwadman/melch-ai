# melchizedek-agents

A multi-model, multi-agent orchestration framework built on the Google Agent Development Kit (ADK). Agent hierarchies, prompts, models, tools, and delegation rules are declared in YAML files called **Syndicates**; the engine in `lib/` runs whatever you put in `config/agents/`.

Gemini runs natively, Claude runs via a bundled adapter, GPT, Grok, and Kimi route to their providers, and open-weight models run locally through Ollama with no API key. A subagent can also pick up tools at runtime from a Model Context Protocol (MCP) server.

> Companion repository for the curriculum at [lyceumagents.com/curriculum](https://lyceumagents.com/curriculum/). The framework works standalone or alongside the course.

---

## Features

- **Declarative YAML configuration** — Orchestrators, subagents, routing, output schemas, and tool assignments in one readable document. Tools and guards are registered in code; YAML names them.
- **Multi-model routing** — Mix providers within the same agent graph (`gemini-*`, `claude-*`, `gpt-*`, `grok-*`, `kimi-*`, and local `ollama/*`). Switching an agent's model is a one-line change.
- **MCP integration** — Give a subagent an `mcp_server_url:` and the server's tools are discovered and wrapped as agent tools at runtime. URLs are SSRF-guarded.
- **Persistent sessions & long-term memory** — Optional Supabase backend for session persistence and pgvector memory: transcripts are distilled into structured records and recalled by similarity in later sessions. Without it, sessions run in memory.
- **Native tools** — Web search, image generation, and a blind image-inventory tool that accepts only a file path, so the expected result can never reach the observer.
- **Agent-to-Agent (A2A) serving** — Serve any syndicate over HTTP as a JSON-RPC endpoint with bearer auth and rate limiting.
- **Knowledge bundle** — `wiki/` documents the framework as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) bundle; `lib/wiki/` builds, lints, and searches any such bundle (`npm run mcp:wiki` serves the tools to MCP clients).
- **Coding agent skills** — Six skills in the open `SKILL.md` standard for Claude Code, Codex, Cursor, OpenCode, and Gemini CLI.

---

## Quick Start

### 1. Local-only (no API keys)

Prerequisite: install [Ollama](https://ollama.com).

```bash
npm install
ollama pull qwen3:8b

# An assistant that converses, summarizes, keeps a task list, and queues jobs
npm run syndicate:assistant

# (Optional, in a second terminal) Run background jobs queued by the assistant
npm run assistant:worker

# A single local teaching agent
npm run syndicate:tutor

# A three-agent advocate/skeptic council, still local
npm run syndicate:council
```

`config/agents/examples/assistant.yaml` is the file to copy when you start your own agent.

### 2. Cloud models

```bash
cp .env.example .env    # add GOOGLE_GENAI_API_KEY (free from Google AI Studio)
npm run chat:syndicate  # interactive REPL with the default syndicate (Gemini)
npm run doctor          # shows which syndicates your current keys unlock
```

Other providers are optional: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, and `MOONSHOT_API_KEY` unlock the syndicates that use them (for example `npm run syndicate:claude`).

Test the providers you have keys for:

```bash
npm run demo:models     # one prompt to every available provider, with token/latency traces
npm run demo:direct     # a single ADK call without syndicate orchestration
```

---

## Usage as a Library

Install into your existing project:

```bash
npm install melchizedek-agents
```

Define your agents in `./config/agents/mine.yaml`, then run turns programmatically:

```typescript
import { InMemorySessionService } from '@google/adk';
import { loadSyndicate, registerAvailableProviders, runSyndicateTurn } from 'melchizedek-agents';

// 1. Register a provider for every key that is set
registerAvailableProviders();

// 2. Load and validate syndicate YAML from ./config/agents/
const config = loadSyndicate('mine.yaml');

// 3. Execute a turn
const result = await runSyndicateTurn({
  config,
  parts: [{ text: 'What changed in the A2A 1.0 spec?' }],
  appName: 'my-app',
  userId: 'user-42',
  sessionId: 'conversation-7', // same id, same conversation
  sessionService: new InMemorySessionService(),
  events: {
    onProgress: (line) => console.log('…', line)
  },
});

console.log(result.status, result.text);
```

`runSyndicateTurn` is the same runtime the server, CLI, and eval harness use. To read syndicates from somewhere else, pass `loadSyndicate(file, { agentsDir })` or set `MELCHIZEDEK_AGENTS_DIR`. To serve inside your own Express app, mount `(await createA2AApp({ defaultSyndicate: 'mine.yaml', serverSecret })).app`.

The example syndicates ship inside the package at `node_modules/melchizedek-agents/config/agents/examples/`; copy one out as a starting point.

### Custom Tools and Guards

Register custom tools or guards before loading your configuration:

```typescript
import { registerTool, registerGuard, defineTool } from 'melchizedek-agents';

registerTool('myCustomTool', defineTool({ /* ... */ }));
registerGuard(myGuardInstance);
```

### The Model Adapters Alone

`melchizedek-agents/model` is the engine's model layer on its own: one message format for every provider, an adapter per provider, `resolveAdapter` over the same model-id prefixes the YAML uses, and `FallbackAdapter`. It loads no `@google/adk`, so a project that only calls models can leave ADK out. npm 7 and later install peer dependencies by default; skip them with:

```bash
npm install melchizedek-agents --legacy-peer-deps
```

```typescript
import { ClaudeAdapter, OllamaAdapter, resolveAdapter } from 'melchizedek-agents/model';
import type { ModelAdapter, ModelRequest } from 'melchizedek-agents/model';

async function ask(adapter: ModelAdapter, text: string): Promise<string> {
  const request: ModelRequest = {
    model: adapter.model,
    system: 'Answer in one sentence.',
    messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
  };
  for await (const response of adapter.generate(request)) {
    if (response.partial) continue; // deltas while the model writes
    if (response.error) throw new Error(response.error.message);
    return response.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  }
  return '';
}

// Claude: the key comes from ANTHROPIC_API_KEY in the environment.
console.log(await ask(new ClaudeAdapter({ model: 'claude-sonnet-4-6' }), 'What is A2A?'));

// Ollama: a local model, no key (OLLAMA_BASE_URL, else http://localhost:11434/v1).
console.log(await ask(new OllamaAdapter({ model: 'ollama/qwen3:8b' }), 'What is A2A?'));

// Or by id, with the same routing as a syndicate's `model:` field.
const adapter = resolveAdapter('ollama/qwen3:8b');
```

A Gemini id resolves to the engine's `GeminiAdapter` here. The ADK-backed Gemini adapter, the ADK shims and `resolveModel` stay under `melchizedek-agents/models/*`, which need ADK.

### CLI & Server Utilities

- `npx melchizedek-chat --syndicate <name>`: Interactive CLI REPL for any syndicate.
- `npx melchizedek-serve`: Serve your `./config/agents/` over HTTP via JSON-RPC.
- `npx melchizedek-doctor`: Report which syndicates your keys unlock, without sending a request.
- `npx melchizedek-skills install`: Install the agent skills into `.claude/skills/` and `.agents/skills/`.

---

## Example Syndicates

Configurations live in `config/agents/examples/` and each demonstrates a different orchestration pattern:

| Syndicate | Pattern | Course Module |
|---|---|---|
| `assistant.yaml` | Conversational orchestrator with a persistent task list and a background job queue (local) | — |
| `harness.yaml` | Works from installed Agent Skills the way a coding harness does: an index in the prompt, a skill read on demand, `/name` to force one | — |
| `weather.yaml` | An HTTP API as tools from its OpenAPI spec (`openapi:`), no tool code, on Open-Meteo's keyless APIs | — |
| `pipeline.yaml` | A syndicate as a graph (`workflow:`): route on a field, fan out, join, retry, ask the person, publish | — |
| `tutor.yaml` | Single local agent (Ollama); the anatomy of an instruction block | [1.03 · Agent Design](https://lyceumagents.com/curriculum/agent-design/) |
| `council.yaml` | Advocate/skeptic council weighed by an orchestrator (local) | [1.05 · Workflows & Voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `critic.yaml` | Drafter → Critic loop that re-drafts until a parsed confidence score clears the bar | [1.04 · Testing & Refinement](https://lyceumagents.com/curriculum/testing-and-refinement/) |
| `delegation.yaml` | Intent routing to specialists via agent descriptions | [1.05 · Workflows & Voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `hierarchical.yaml` | Goal decomposition into sequential research and writing stages, then a checked merge | [1.05 · Workflows & Voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `style_council.yaml` | Three stylists with identical knowledge and different voices, behind one router | [1.05 · Workflows & Voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `syndicate.yaml` | Orchestrator paired with a grounded research subagent | [2.01 · The Protocol](https://lyceumagents.com/curriculum/melchizedek-protocol/) |
| `ares.yaml` | Long-term memory pipeline: preload, explicit recall, write at session end | [2.02 · Memory Systems](https://lyceumagents.com/curriculum/memory-systems/) |
| `patient_advocate.yaml` | Memory across sessions: diagnoses, medications, lab trends | [2.02 · Memory Systems](https://lyceumagents.com/curriculum/memory-systems/) |
| `librarian.yaml` | Tools discovered at runtime from an MCP server, including writes | [2.03 · MCP](https://lyceumagents.com/curriculum/mcp-extending-reach/) |
| `image_production.yaml` | Spec-first image generation, a blind inventory, and a separate spec auditor | [2.04 · Multimodal Agents](https://lyceumagents.com/curriculum/multimodal-agents/) |
| `augustin.yaml` | Fact-checking: an X researcher and a web researcher report to a tool-free arbiter | [2.05 · Fact-Checking Arbiter](https://lyceumagents.com/curriculum/fact-checking-agent/) |
| `claude.yaml` | Minimal configuration using the Anthropic adapter | — |
| `model_zoo.yaml` | One agent per provider (Qwen, Claude, Grok, GPT, Gemini, Kimi) | — |
| `research.yaml` | Plan-and-dispatch over keyless clinical and literature sources, with an identifier and retraction guard | — |
| `scriptorium.yaml` | Agents over the `wiki/` bundle: answer with citations, author through a validated save gate | — |
| `cartographers.yaml` | Agents that record the judgments in the wiki's prose as graph relations | — |
| `scribe.yaml` | A brief in, a finished document out: draft, audit against the brief, revise | — |

See `config/agents/syndicateSchema.yaml` for the annotated schema reference.

---

## Documentation

- [`QUICKSTART.md`](./QUICKSTART.md) — Detailed setup, including the optional Supabase/pgvector database.
- [`DOCUMENTATION.md`](./DOCUMENTATION.md) — Full reference: architecture, syndicate YAML, tools, memory, providers, A2A, extending, security.
- [`AGENT_SETUP.md`](./AGENT_SETUP.md) — A paste-ready prompt that walks your coding agent (Claude Code, Cursor, Codex) through setup.
- [`skills/README.md`](./skills/README.md) — The bundled `SKILL.md` suite.
- [`VERSIONING.md`](./VERSIONING.md) — What an upgrade may break, deprecation, and which versions get fixes.
- [`SUPPORT.md`](./SUPPORT.md) — Where to ask, and what to expect: a single-maintainer project with no SLA.
- [`SECURITY.md`](./SECURITY.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE).
