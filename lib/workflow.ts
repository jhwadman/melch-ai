/**
 * lib/workflow.ts — the `workflow:` block: a syndicate as a graph.
 *
 * ── The third orchestration method ───────────────────────────────────────
 * DELEGATE lets an orchestrator call subagents as tools; PLAN-DISPATCH
 * (lib/dispatch.ts) lets a classifier pick ONE subagent to answer. Neither
 * can say "run these two in parallel, join their outputs, review, ask the
 * person, then publish". A `workflow:` block does: it is a graph whose
 * nodes are the syndicate's own agents plus a few node kinds the engine
 * supplies, and whose edges say what runs after what and on which route.
 *
 *   workflow:
 *     edges:
 *       - [START, Planner, { article: [Writer, Checker], answer: Answerer }]
 *       - [[Writer, Checker], Both, Editor, Confirm, Publisher]
 *     nodes:
 *       Both:    { join: true }                 # waits for every predecessor
 *       Confirm: { ask_user: "Publish? yes, or say what to change." }
 *       Planner: { route_key: "kind", retry: { max_attempts: 2 } }
 *
 * The engine's scheduler walks it (lib/workflow/, ADR 0095): per-node
 * retries and timeouts, fan-out and fan-in, a pause that waits for a person
 * and resumes on the next message, and resumption from the session's own
 * events, which are the JSON ADK's Workflow stored before 1.0.0. A node
 * agent receives the previous node's output as its user turn and, unless
 * its YAML sets `includeContents`, sees nothing else of the conversation.
 *
 * ROUTING. A routing map in YAML gets a hidden step after the agent
 *   (`<Agent>__route`) that reads the route from the output — the
 *   `route_key` property of a JSON output, else the trimmed text — and
 *   re-emits the output with it. A `default` key catches what no key
 *   matched.
 * THE PAUSE. `ask_user` is a node that asks the person (`adk_request_input`).
 *   The turn ends `input-required` carrying the question (`result.input`);
 *   the next message on the conversation is the answer and becomes that
 *   node's output. The A2A server publishes the question; the chat prints it.
 * NAMES. Nodes are addressed by their YAML names everywhere (edges, events,
 *   the wiki), including a `map` node.
 *
 * ── As a subagent (ADR 0098) ─────────────────────────────────────────────
 * A delegated `yaml_reference` to a workflow syndicate is the whole graph,
 * walked under the subagent entry's name and description on a child
 * session (lib/compileNative.ts workflowSubagentOf); its answer is the
 * graph's last event's text. A walk that pauses (an `ask_user` node, a
 * gated agent node) leaves the call open, and the turn ends input-required
 * with the agent path down to the node; the answer walks the graph again
 * (lib/runtime/native/delegate.ts resumeWorkflowSubagent, ADR 0111).
 *
 * ── As a dispatch route or a workflow node (ADR 0106) ────────────────────
 * A `yaml_reference` to a workflow syndicate runs its whole graph there too,
 * on the child session filed under the agent path (`<app>/<entry>`, ADR
 * 0119), as a subagent does. A route's answer is what the graph would
 * answer as its own syndicate (lib/runtime/syndicateTurn.ts); a node's is
 * the nested walk's (lib/workflow/turn.ts). A map over one is refused
 * (lib/compile.ts). Its pauses (an `ask_user` node, a gate) reach the turn
 * with the path from the entry down to the node that asked: a route's
 * through the route's pause record in the conversation, a node's through
 * its own pause on the caller's walk; the answer walks the nested graph
 * again (ADR 0119).
 *
 * ── Approval gates (ADR 0098, ADR 0106) ──────────────────────────────────
 * A tool in a node agent's `require_approval`, and a skill script
 * (`skills.scripts: local`, run_skill_script), pause the node on
 * `adk_request_confirmation`, and the walk with it; the answer resumes the
 * pinned call (lib/workflow/agentNode.ts). The schema refuses
 * a gate or skill scripts on an agent a map runs (an item cannot pause the
 * walk). A script runs with ADR 0086's minimal environment, as anywhere.
 *
 * ── Not in this version ───────────────────────────────────────────────────
 * Remote `a2a_agent_url` subagents are refused inside a workflow by the
 * schema; a remote agent is reachable only as a tool. It is open for a
 * later record.
 */

export * from './workflowConfig.ts';
