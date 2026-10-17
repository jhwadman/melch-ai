---
type: decision
title: "ADR 0137: A syndicate may orchestrate with a script run in a QuickJS sandbox, resumed by replaying a journal of its calls, and agents get a provider-neutral run_code tool in the same sandbox"
description: "A fourth orchestration method, script:, holds one JavaScript function that calls the syndicate's own agents, tools and askUser pauses as functions, so dispatch logic, per-call model choice and human-in-the-loop live in the syndicate document and change with a deploy, not an engine release. It runs in a QuickJS wasm sandbox on a worker thread that can reach only the functions passed in. Each call is journaled in the session as a node-style event; a paused turn resumes by running the pinned script again from the top and answering recorded calls from the journal, in program order. run_code is a registry tool in the same sandbox, so any agent on any provider can rest an answer on code that ran, attaching the code when run_code.attach says so. Both are off until the operator sets MELCHIZEDEK_CODE_SANDBOX=on. Supersedes ADR 0033's clause that local execution of model code is not offered. An expression language on workflow edges, a code: workflow node, node:vm, isolated-vm, the asyncify build, an in-thread sandbox, a journal in function responses, Pyodide and code that calls tools were rejected or deferred."
tags:
  - decision
  - orchestration
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-17
sources:
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/pause.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/runtime/native/checkpoint.ts
  - resource: lib/session/transcript.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/compile.ts
  - resource: lib/sandbox/sandbox.ts
  - resource: lib/sandbox/worker.ts
  - resource: lib/tools/runCodeTool.ts
  - resource: lib/script/run.ts
  - resource: lib/script/journal.ts
  - resource: tests/codeSandbox.test.ts
  - resource: tests/scriptOrchestration.test.ts
---

# ADR 0137: A syndicate may orchestrate with a script run in a QuickJS sandbox, resumed by replaying a journal of its calls, and agents get a provider-neutral run_code tool in the same sandbox

> **Accepted 2026-10-17; implemented in full in 1.7.0.** Drafted, reviewed against 1.6.0 and melch-app 0.2.3, and accepted the same day; the review's amendments and the owner's four decisions are folded into the text below (the **Review record** at the end says what changed). Delivery steps 1 and 2 shipped together in 1.7.0, with the amendments the **Implementation record** lists; step 3 is melch-app's (its asarUnpack, template filter, pause cards, journal view and trace rows). The **Deferred** section stays deferred.

## The request

The owner asked for a way to put code inside a syndicate, for "syntax that might dispatch agents or run more deterministic logic between agents." The uses named were:

- logic deciding which agents run, when dispatching them;
- changing the syndicate according to conditions, "like switching the model";
- human awaits for human-in-the-loop;
- all of it "defining it all in a contained syndicate document."

The goal behind it: "I don't have to ship a new major change to code to adjust a workflow; instead, I just deploy a new syndicate."

Separately, code execution for agents is required: "so that the agents can, in a helpful way, produce deterministic code in its responses."

## Context

The engine has three orchestration methods: DELEGATE, plan-dispatch (`dispatch:`, `lib/dispatch.ts`) and workflow graphs (`workflow:`, ADR 0030). Each decides the order agents run in, but none can hold logic. A workflow routes on a route key or the trimmed text, `tool:` nodes run a registry tool, and `ask_user` nodes pause. There is no condition beyond matching a route, no loop, no transform between nodes, and no way to choose a model per call.

Every new kind of decision added as YAML keys (a `when:` on an edge, a `model_when:` on an agent, a `skip_approval_if:`) is an engine release. That is the cost the request wants gone. So the primitive has to be general enough that the next decision needs no new key.

Code execution today is `code_execution: "gemini"` only: Python in Gemini's server-side sandbox, available on Gemini models alone (ADR 0033). ADR 0033 also decided that local execution of model-written code is not offered, because ADK's local executor ran it on the host unsandboxed and its container executor needed a Docker daemon, and it rejected an approval prompt as the remedy because a person cannot review generated code under time pressure. A wasm sandbox with no host reach is neither of those executors, and it needs no approval because it grants nothing; this record supersedes that clause of [ADR 0033](/decisions/0033-context-task-code.md).

The engine already rebuilds a paused workflow from the session's events and walks it again from START (ADR 0094, `lib/workflow/resume.ts`). A script can resume the same way. Replay from a journal is also the model durable-function systems (Temporal, Restate, DBOS) use, and their determinism rules carry over: a script must make the same calls in the same program order on every run, and a run that does not is an error the engine names.

The facts the design rests on, verified in the code:

- `MAX_RESULT_CHARS` is 20,000 (`lib/tools/tool.ts`); `retries.tool_errors` is a root key; `max_steps` charges through `chargeLlmCall`, and the deadline and the cancel ride the same `TurnControl` (`lib/runtime/turnControl.ts`).
- `result.input` is one shape for an `ask_user` node, the `ask_user` tool and an approval (`lib/workflow/pause.ts`, `lib/runtime/questions.ts`), so a client that handles a workflow pause handles a script pause.
- An agent with `output.schema` yields parsed JSON to a workflow (`eventOutput`, `lib/workflow/agentNode.ts`).
- The Supabase session service passes every event through `trimEventForStorage` (`lib/session/transcript.ts`), which elides any function response over 2,000 characters; the Postgres adapter stores events verbatim. `event.output` and `actions.agentState` are never trimmed.
- `compileSubagentSpec` resolves an agent's model once (`resolveAgentModel`, `lib/compile.ts`), and `withReasoning` keys on the model id.
- A durable run's checkpoint boundary is an append carrying function responses after which every call has its response (`lib/runtime/native/checkpoint.ts`).
- Nothing in `lib/` uses `worker_threads`; QuickJS in wasm runs synchronously on the thread that calls it.
- `quickjs-emscripten` 0.32.0 is a meta-package over four variants (debug and release, sync and asyncify); `quickjs-emscripten-core` with `@jitl/quickjs-wasmfile-release-sync` is about 1.4 MB unpacked with one `.wasm`.
- `{{token}}` interpolation runs over every string in the YAML before validation (`lib/loadSyndicate.ts`).
- melch-app 0.2.3 externalizes dependencies and unpacks only three packages from its asar; its template picker skips any file without `orchestrator` or `workflow`; its graph view reads no run; it has no pause UI (the P1 in its enterprise-readiness audit of 2026-10-16); its editor validates through `validateSyndicateConfig`.

## Decision

### Part A: one sandbox, and `run_code` for agents

1. **One sandbox: QuickJS compiled to wasm, on a worker thread.** The engine depends on `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` (the sync build; not the `quickjs-emscripten` meta-package, which installs four variants). It is plain JavaScript plus one `.wasm`, no native module, so it ships in the A2A server, the worker and the desktop app's Electron build alike (the desktop build must list the two packages in `asarUnpack`, since loading wasm from inside an asar is untested there). Each run is a `worker_threads` Worker holding a fresh runtime with a memory limit (default 64 MB), a stack limit, and an interrupt handler that enforces CPU time (default 5 s of compute, measured only while the worker executes, so time awaiting the host is not counted). A worker past either limit, or past the turn's signal, is terminated, a harder stop than the interrupt handler, which QuickJS consults only between bytecodes. Runs are capped by a small pool, so memory is bounded. There are no `fetch`, timers, file system, `process` or environment variables; a prelude masks `Date.now`, the current-time `Date` constructor and `Math.random`. The only globals are the ones the host passes in. Values cross as JSON both ways, which is the "JSON-serializable" rule enforced rather than described.
2. **`run_code` is a registry tool.** An agent lists it as `tools: [run_code]`, so it gets what every registry tool gets: `require_approval`, MCP exposure (ADR 0125), the result bound, and `retries.tool_errors` (ADR 0034) on a thrown error. It takes `{ code, input? }`: the code is a JavaScript module whose default export is called with `input`, and the tool returns `{ result, logs, error }`, `result` the export's JSON-serializable return, `logs` the `console.log` output, each bounded at 20,000 characters. It works on any provider, since the model only writes text.
3. **`run_code: { attach: true }`** on the agent, beside `tools:` as `mcp_tools` sits beside `mcp_server_url`, also attaches each run's code and result to the reply as a data part (`{ type: "code_run", code, result }`). Default off. The schema refuses `run_code:` on an agent whose `tools` do not list it. With `attach`, the text rests on code a reader can see and run again: that is what "deterministic code in its responses" means here.
4. **Off by default.** Running code, model-written or operator-written, is on only when the operator sets `MELCHIZEDEK_CODE_SANDBOX=on`, as stdio MCP runs only under `MELCHIZEDEK_STDIO_MCP` (ADR 0132). Without it, an agent that lists `run_code` and a syndicate with `script:` are refused at load, naming the variable. The sandbox grants no power the agent lacks (no network, no host, no keys), so the gate is a posture, not a boundary: a deployment that never meant to run code does not start doing so because a YAML changed.

### Part B: `script:`, the fourth orchestration method

5. **`script:` at the root holds the orchestration.** It is one JavaScript module whose default export is an async function. The YAML still declares the orchestrator and subagents, with their instructions, tools, guards, schemas and gates. The script decides which run, in what order, with what input and on which model. `script:` cannot be combined with `dispatch:` or `workflow:`. The orchestrator is just an agent the script may call: every agent of a script syndicate compiles as a subagent does, with no delegation tools, so nothing delegates. `{{token}}` interpolation does not enter `script.source`; the script reads `variables` itself.

   ```yaml
   syndicate_name: "Desk"
   memory_system: "internal-only"
   script:
     models: ["gemini-3.8-flash", "claude-opus-5-5"]   # the models agent() may switch to
     tools: ["publish"]                                 # the registry tools tool() may run
     source: |
       export default async ({ message, agent, tool, askUser, parallel, log }) => {
         const triage = await agent("Triage", message);            // JSON: Triage has output.schema
         const model = triage.complexity === "high" ? "claude-opus-5-5" : "gemini-3.8-flash";
         log(`Routed to ${triage.route} on ${model}`);
         const draft = await agent(triage.route, message, { model });
         if (triage.risky) {
           const ok = await askUser("confirm-send", "Send this reply?", { payload: { draft } });
           if (!/^y/i.test(ok.reply)) return agent("Editor", { draft, notes: ok.reply });
         }
         return draft;
       };
   orchestrator: { name: "Triage", model: "gemini-3.8-flash", instruction: "…", output: { schema: … } }
   subagents: [ … ]
   ```

6. **The script reaches the engine only through the functions it is passed:**

   | Function | Does |
   |---|---|
   | `agent(name, input, opts?)` | Runs a declared agent on `input` (text, or JSON sent as its text), on a fresh child session keyed `<app>/script:<seq>` (the ADR 0120 style), seeing only that input, as a workflow node does; two calls to one agent never share history. It returns the parsed JSON if the agent has an `output.schema`, else the text. `opts` may set `model` (one of `script.models`), `reasoning` and `sampling.temperature`; any other key is an error. A `yaml_reference` agent runs as it does as a workflow node (ADR 0106, 0120). The call reports through `events.onAgentEvent` (ADR 0135) with the branch path `[<script name>, <agent>]`. |
   | `tool(name, args)` | Runs a registry tool named in `script.tools`. An approval gate on it pauses the turn (item 8). |
   | `askUser(id, question, { payload?, schema? })` | Pauses the turn `input-required` with the same `result.input` an `ask_user` node writes (`lib/workflow/pause.ts`), and returns `{ reply, input }` when it resumes. `id` is required and must be unique within a run. |
   | `parallel(thunks, { max? })` | Runs calls concurrently, `max` at a time (default 4, at most `MAX_DELEGATION_CONCURRENCY`, as `max_concurrency` is bounded), and returns their results in call order, as `Promise.all` does. |
   | `now()`, `random()` | The time and a random number, recorded so a replay sees the same values. |
   | `log(text)` | One `[STATUS]` progress line. |
   | `message`, `variables` | The turn's message text (as a walk takes it, `lib/workflow/turn.ts`; non-text parts are out of reach in this version) and the YAML's bound `variables`. |

   The script's return value is the turn's answer: a string, or JSON. The syndicate's guards run on it once.

7. **Per-call model choice is a per-model compile.** At load, each agent is compiled once per entry of `script.models` plus its own model, and every pairing is validated then: the schema's `code_execution: gemini needs a gemini-* model` rule, the capability matrix (structured output with tools, reasoning keys), and `withReasoning` on that model id. That, beside cost, is why `script.models` is a closed list. `reasoning` and `sampling.temperature` overrides apply to the per-model spec at call time.

8. **Every call is journaled in the session as a node-style event.** Each `agent`, `tool`, `askUser`, `now` and `random` call writes one event: `author` the script's name, `nodeInfo.path` `<script>.<seq>`, the call's kind, name and a hash of its arguments in `actions.agentState`, and its result in `event.output`, with no content parts. Those fields are what workflow nodes and `pause.ts` already keep for a resume, and `trimEventForStorage` never touches them, so the journal replays the same from the Supabase store and the Postgres adapter; no text part also keeps the journal out of long-term memory ingestion, which reads text. The sequence number is assigned when the call *starts*, in program order, never when it completes. The script's source hash is stamped on the first event of the run. A gated `tool()` call's entry stays open with its approval request (ADR 0028's `adk_request_confirmation`) until the decision arrives. Each journal append is a checkpoint boundary for a durable run (ADR 0113): the boundary test in `lib/runtime/native/checkpoint.ts` learns the journal event, so a worker killed mid-script resumes from the last call, not from the message.

9. **Resume is replay.** A paused turn's next message runs the script again from the top, using the source the run was stamped with. Calls answer from the journal, in program order, while their kind, name and argument hash match; a replayed call resolves on a microtask, as a live one does, so continuations interleave as they did. The paused call takes the answer: an `askUser` gets `{ reply, input }`; a gated `tool()` runs its pinned arguments when approved, or returns a refusal result to the script when rejected, as a tool node does (`lib/workflow/toolNode.ts`). Live calls continue after it. A recorded call whose arguments no longer match, or whose entry is elided or unparseable, fails the turn with `SCRIPT_DIVERGED`, naming the call. This is the rebuild-and-walk-again of ADR 0094, applied to a script, and `eventsForCurrentRun` (`lib/workflow/resume.ts`) sees a script run as it sees a walk. The determinism rules an author keeps, stated in the schema doc: `parallel` returns in call order; `Promise.race`, `Promise.any` and state mutated in completion order diverge on replay.

10. **In-flight calls at a pause settle first.** Under `parallel`, one thunk can reach `askUser` while another's `agent()` is still running. The turn waits for in-flight `agent()` and `tool()` calls to settle and journals them before writing the pause record (the deadline still bounds the wait), so the resume replays them instead of paying for them again. A second `askUser` reached at pause time is not recorded; it raises again after the first is answered, keeping ADR 0030's one open question per turn.

11. **A paused run keeps the script it started on.** Redeploying a syndicate must not break a conversation waiting at `askUser`. The pause event stores the script source, and the resume runs that source, not the newly deployed one. Agents are still looked up by name in the current YAML, so a prompt fix applies to the rest of the run, and an agent the new YAML removed fails the resume, naming it. A new conversation, or a message after the run finished, gets the deployed script.

12. **Pauses inside a called agent are refused in this version.** `agent()` runs a whole agent loop, and a journal entry for a half-run agent has no result to replay. So the schema refuses, by name, `require_approval`, the `ask_user` tool and a tool that needs an OAuth consent on any agent of a script syndicate, as ADR 0094 refused agent-node pauses before ADR 0098 and ADR 0119 lifted them. The script's own `askUser` and a gated `tool()` are its pauses. Keeping each call's child session resumable through the nested-pause machinery (`deepestPause`, `resumeWorkflowSubagent`) is the follow-up record that lifts this.

13. **Limits are the turn's limits, plus one.** Each `agent()` call runs under `max_steps` (`chargeLlmCall`), the turn's deadline and cancel apply, and a run of the sandbox's own compute is held to its CPU limit. Replayed calls are not charged again. `max_steps` counts model calls only, so a run also has a journal-entry ceiling, `SCRIPT_CALL_LIMIT` (default 1,000, as walks have `NODE_RUN_LIMIT`, ADR 0105), failing the turn by name; it also bounds the Supabase service's whole-array rewrite per append. `script.source` is at most 64 KB.

14. **Placement rules restated for a script syndicate.** The schema's rules that key on `workflow:` get a `script:` branch: `mode: task` is allowed on script agents (typed output after tool use is what `agent()` wants); `context:` is refused (every call is fresh); `max_concurrency` at the root is refused (`parallel` has `max`); `code_execution: gemini` stays allowed where the agent's model, and every `script.models` entry it may be moved to, is Gemini.

15. **Nested.** A `yaml_reference` to a script syndicate runs the whole script wherever it appears (as a DELEGATE subagent, a dispatch route or a workflow node), and a pause inside it pauses the whole turn with the path, as ADR 0111 and 0119 do for workflows. A script may call a workflow or dispatch syndicate through `agent()`. Fixed pipelines that Studio should draw before they run stay `workflow:`, and logic goes in `script:`.

16. **Traces.** Mirroring the walk (`lib/workflow/turn.ts`): `script.invoke <name>` around the run and `script.call <kind>:<name>` around each live call, with an `agent()` call's `agent.invoke` opening inside it so the ledger attributes model calls to the script. A replayed call opens no span; the journal is its record. Studio draws a script run's graph from its journal events after it runs.

### Order of delivery

1. **Sandbox and `run_code`** (one minor release): `lib/sandbox/` with the worker, the QuickJS wrapper and the limits; `run_code` as a registry tool with the `run_code:` agent key; `MELCHIZEDEK_CODE_SANDBOX`; `tests/codeSandbox.test.ts`, offline (the sandbox needs no model). Shippable on its own.
2. **`script:`** (the next release): schema and `crossFieldProblems`, the per-model compile, the runner with the journal, replay, the pinned source on pause, spans; `tests/scriptOrchestration.test.ts` on `tests/helpers/scriptedModel.ts`, with a replay-after-pause case, a divergence case and a `parallel` case. `schema:gen`, `syndicateSchema.yaml`, the package surface and `CHANGELOG.md` in the same change.
3. **melch-app**, on its own schedule: `asarUnpack` for the two packages and a new vendored tarball; the template filter learns `script:`; the journal view and a trace row kind for the script spans; and the pending-interaction work (pause cards and typed answers), a pre-existing P1 that gates approvals and questions on every method, not only scripts. The engine ships first; the A2A server and the CLI chat handle a script pause the day it lands, since `result.input` is one shape.

## Alternatives rejected

- **An expression language (CEL or JSONata) on workflow edges and nodes.** It is safe and drawable, but each new place an expression may appear is a new schema key and an engine release, which is what the request wants to avoid. Inside a script, the conditions are ordinary JavaScript.
- **A `code:` workflow node only.** It transforms data between nodes but cannot choose which agent runs, change a model or pause. It would be a second home for logic beside the script. The sandbox it needed is Part A.
- **`node:vm`.** It is not a security boundary, and syndicate YAML can come from the registry (`lib/registry.ts`), not only from a file the operator wrote.
- **`isolated-vm`.** It is a native module, rebuilt per Node and Electron ABI, which breaks the desktop build and complicates deploys.
- **The sandbox on the calling thread.** Five seconds of compute would stall every other turn, stream and MCP call in the A2A server, and freeze melch-app's engine process. A worker thread keeps the "no native module" property and adds a hard stop.
- **The asyncify build.** It exists so a host function can block the VM synchronously; the script needs none of that, since host calls return VM promises the host resolves. It is twice the size and slower.
- **`code_execution: "sandbox"` as the spelling for `run_code`.** `code_execution:` names a provider-side native (Gemini's executor is request-level, not a tool). A registry tool gets `require_approval`, MCP exposure and the result bound without new code, and `run_code:` beside `tools:` follows how `mcp_tools` configures a named tool.
- **On by default with an operator off switch.** The sandbox grants nothing, but a deployment that never meant to run code should not start doing so because a YAML changed; the engine's posture for every new way to run something is an operator opt-in (ADR 0132).
- **Attach always on.** A reader can always benefit from seeing the code, but a syndicate whose client renders data parts as text would print code into its answers; the operator chooses.
- **The journal as function responses.** The Supabase store elides function responses over 2,000 characters before writing them, so an `agent()` result would replay on one store and break on the other.
- **Keying replay on completion order.** Under `parallel` it varies between runs; program order does not.
- **Resuming pauses inside a called agent now.** It is the hardest part of Part B and the least likely to be needed first; the script has pauses of its own, and the engine's own history (ADR 0094, then 0098 and 0119) is to refuse, then lift.
- **Restart-from-top for a durable script job.** The boundary test is one predicate, and the journal is exactly the state a resume needs; restarting re-pays every `agent()` call up to the kill.
- **Holding Part B for melch-app's pause UI.** That UI is a pre-existing P1 that blocks approvals and questions on every method; tying the engine release to it would hold a working feature to unrelated app work.
- **Resuming from a saved snapshot of the sandbox.** QuickJS heap snapshots are tied to the build, large, and cannot move between engine versions. The journal is a few rows of JSON.
- **Resuming a paused run on the newly deployed script.** Replay would diverge on any edit above the pause, so every deploy would break waiting conversations.
- **Free model choice in `agent()`.** A script could then move a turn to a model the operator never meant this syndicate to use, or to a dearer one, and each pairing could not be validated at load. `script.models` lists them.

## Deferred

- **Code that calls tools** (`run_code` with the agent's tools passed in; what Cloudflare's Code Mode and Anthropic's programmatic tool calling do). It saves round trips on data-heavy work, but model-written code would then reach tools, so it needs every `require_approval` gate to pause inside a sandbox run first.
- **Pauses inside a called agent** (item 12): the nested resume through each call's child session.
- **Python in the sandbox (Pyodide).** About 10 MB of wasm and slow to start. JavaScript first; add it if agents need Python's libraries.

## Consequences

- Deploying a syndicate can now change orchestration logic, so a syndicate file is code, and a registry publish of a script syndicate is a code deploy, gated as one (ADR 0018). The sandbox and the functions passed in are the boundary; `script.tools` is the only path from a script to the network or the host, and it is an allowlist the operator wrote. Review a `script:` as you would code.
- Nothing runs code until the operator sets `MELCHIZEDEK_CODE_SANDBOX=on`; a syndicate that needs it says so in its load error.
- QuickJS's C engine has had memory-safety CVEs; inside wasm they corrupt the instance's linear memory, so the worst case is a crashed run the worker contains, not host code. The package version is pinned and recorded in the security posture doc.
- Script authors give up `Date`, `Math.random`, timers and I/O inside the script, using `now()`, `random()` and `tool()` instead, and keep the determinism rules of item 9.
- A script run cannot be drawn before it runs. melch-app's `AgentGraph` draws only the YAML's orchestrator and subagents today and reads no run; the journal view is new work there (Order of delivery, 3).
- `code_execution: "gemini"` stays. `run_code` works on every provider.
- Cross-repo: the schema doc, `syndicateSchema.yaml` (hand-maintained) and `syndicate.schema.json` (`npm run schema:gen`) and the wiki gain the fourth method and the tool; melch-app's Studio, Traces, templates and pause cards need their own changes; melch.ai's copy follows (melch-network-check).

## Implementation record (1.7.0, 2026-10-17)

What the implementation settled that the text above left open or got wrong, so the record matches the code:

- **Replay matches a call by identity, not by position.** Item 9 keyed replay on program order, with the sequence number assigned when a call starts. Under `parallel` with `max` below the number of thunks, which thunk starts next depends on which finished first, so start order is not program order on a second run. A replayed call takes the first unconsumed journal entry with the same kind, name and argument hash; the sequence number only names the event's path. A run that ends with an entry it never made again fails `SCRIPT_DIVERGED` naming it, and a resume that never reaches its open question fails the same way. `log()` lines are not repeated while entries remain to replay.
- **The journal is stored when a run pauses, not as each call ends.** Item 8 wrote one event per call as it happened. Only a paused run reads its journal, and on the Supabase store every append rewrites the session's whole event array, so a router turn would have paid twice the writes of the dispatch turn it replaced. The runner keeps the events in memory and stores them with the pause; a run that finishes stores none, and the conversation keeps the exchange (the message, and the answer unless a `conversation: true` call stored it). A resumed run that ends stores its answer's event and an `end` marker, closing it; one the turn's signal stopped stays open, so the next message retries the resume. The event shape is item 8's.
- **`agent(…, { conversation: true })`.** A port of a plan-dispatch syndicate needs its route to answer in the conversation, seeing the history through the projection and storing its exchange there, as a dispatch route does; with `conversation: true` it does, and its reply streams. `input: null` sends the run's message (the turn's own parts on a fresh run). Without it a call runs on a throwaway in-process lane (`<sessionId>::script:<seq>`), as the classifier's does, rather than a stored child session `<app>/script:<seq>`: sequence numbers restart every run, so that key would mix runs, and the journal entry is already the call's record. The option is spelled `temperature`, not `sampling.temperature`.
- **`transcript`.** The script receives the classifier's transcript digest (`renderTranscriptDigest`) beside `message`, and both are pinned on the pause with the source, so a resume sees the inputs the run started on.
- **Fail-static stays the script's.** A failed agent run throws into the script, which may catch it; uncaught, the turn fails with that run's own error code, as a failed dispatch route does. The script's own error fails `SCRIPT_ERROR`, `failedStage: 'script'`.
- **The per-model compile happens on first use; the pairings are checked first.** Item 7 compiled every agent × model at load. An agent's compile lists its MCP tools, so the runner compiles each (agent, model, reasoning, temperature) once per turn, when the script first calls it. Before the run starts, each `script.models` entry is resolved and each inline agent's reasoning is mapped onto it (`withReasoning`), so a pairing that cannot run fails the turn `SCRIPT_MODEL_INVALID` before any model call; the schema checks `code_execution` against every entry at load. `temperature` is also accepted as `sampling.temperature`.
- **The switch is enforced when a turn starts**, before the session is touched (`refuseOnNative`, `CodeSandboxOffError`), not in `loadSyndicate`: the doctor, the wiki build and `npm run check` load files they never run.
- **A gated `tool()` is `script.require_approval`.** Item 8 named the gate without a key; the key lists tools from `script.tools`. A call to one pauses the run with ADK's approval request pinning the call (`result.approval`, one shape with every gate, so the A2A server's approve and reject reach it); a message that is not the decision repeats the request and runs nothing; approved, the pinned arguments run; refused, the script gets `{ error: "This tool call is rejected." }`.
- **Durability (item 8's last sentence).** Under the durable-run store (`runDurableTurn`, ADR 0113), which declares `JOURNAL_EVERY_CALL`, the turn stores the message first and each journal event as its call ends, the first carrying the run's pin (`script_run`), and every journal append is a step boundary. A restored checkpoint holds the journal, the run is found unfinished (its last journal event a call, not a pause or an `end`), and the script replays to the last call instead of paying again. A finished durable run stores an `end`. Outside that store an unfinished run is never resumed: the next message is new. A conversation call in a durable run stores the message a second time (the route's own append), a limit of that pairing.
- **Spans (item 16), in their own trace.** `script.invoke <name>` (a root) and `script.call <kind>:<name>` under it, carrying the run, the source hash, each call's kind, name, sequence and status, the call and replay counts, and never an argument or a result. Each `agent()` call's turn span (`Syndicate Execution: …`) stays a root of its own, as a dispatch stage's does, so the ledger's per-stage rows are unchanged, and carries `script.run` and `script.call.seq` for a trace view to pair. Both script spans are exported to `adk_telemetry`. A replayed call opens no span.
- **Live events.** An `agent()` call reports through `events.onAgentEvent` with the branch `{ agent, path: [<script>, <agent>], callId: <run>.<seq> }` (ADR 0135).
- **`askUser`'s schema.** As an `ask_user` node's: the schema travels on `result.input`; with one, a JSON reply is parsed and plain text passes as is.
- **Nesting (item 15).** A `yaml_reference` to a script syndicate compiles as a nested dispatch syndicate does (ADR 0120): a turn of its own, as a delegated subagent, a dispatch route or a workflow node, its pauses reaching the turn with the path (the pause readers recognise a script's pause, and a script's journal events are not taken for a walk's). From a script, `agent()` runs a nested workflow, dispatch or script syndicate on a throwaway lane; a pause inside one fails `PAUSE_INSIDE_AGENT` (item 12), as a gate, question or consent request inside a called agent does.
- **First users.** The deployment's two Discord routers (`financial_router`, `archimedes` in melchizedek-deploy) moved from `dispatch:` to `script:` with their overrides, classifier digest, fail-static default and progress line unchanged.

## Review record (2026-10-17)

The first draft was reviewed against 1.6.0 and melch-app 0.2.3 before any implementation. What the review changed, kept here so the record shows the draft was not accepted as written: the journal moved from function responses to node-style events (the Supabase trim); the sandbox moved to a worker thread (event-loop blocking); the sync build replaced the meta-package (size, asyncify unneeded); `code_execution: "sandbox"` became the registry tool `run_code` with a `run_code:` agent key, attach configurable and off by default (owner's decision); the default flipped from on to off behind `MELCHIZEDEK_CODE_SANDBOX` (owner's decision); replay keys on program order with stated determinism rules; in-flight calls settle before a pause; pauses inside called agents are refused for now (owner's decision); journal appends are checkpoint boundaries (owner's decision); per-call model choice became a per-model compile; a call ceiling and the interpolation exemption were added; the claims about melch-app following for free were corrected and the engine ships first (owner's decision); and the supersession of ADR 0033's local-execution clause was made explicit.
