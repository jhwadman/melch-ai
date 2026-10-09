---
name: melchizedek-onboard-keys
description: "Onboard a person to Melchizedek with provider API keys: one key (Gemini, Anthropic, OpenAI, xAI or Moonshot), several, or one Vercel AI Gateway / OpenRouter key, or their ChatGPT plan on their own machine through Sign in with ChatGPT, and answer honestly when they only have a Codex, Claude.ai or Gemini CLI sign-in. Use when someone says 'I have an OpenAI key', 'I have keys for Claude and Gemini', 'I have an OpenRouter key', 'I have ChatGPT Plus', 'can I use my Codex login', or asks which key unlocks which syndicate."
---

## The levels

| Level | Id | Guide |
|---|---|---|
| 2 | `one-provider` | one provider's key funds every agent on that provider |
| 3 | `several-providers` | each key funds its own provider; a syndicate may mix them |
| 4 | `gateway` | one gateway key serves every cloud id whose direct key is absent |
| 9 | `chatgpt-signin` | Sign in with ChatGPT: OpenAI ids on the person's ChatGPT plan, on their own machine only |
| 10 | `subscription-signin` | another app's sign-in is not a model credential; the sanctioned route instead |

Print the guide for the level before you start: `npx melchizedek-setup --level <id>` (in a clone, `npm run setup -- --level <id>`).

## Steps for a key (levels 2 to 4)

1. Create `.env` with the names left blank, if there is none: `npx melchizedek-setup --level <id> --write-env`. It refuses unless git ignores `.env`; if it refuses, add `.env` to `.gitignore` first.
2. Tell the person which variable to fill in and where the key comes from (the guide's table: Google AI Studio, the Anthropic console, the OpenAI platform, the xAI console, the Moonshot platform, Vercel or OpenRouter). They open `.env` in their editor and type the value. Never ask for it in chat.
3. Run `npx melchizedek-doctor`. Read the providers line back: a ✓ beside each provider they set, `◇ via gateway` for providers served by the gateway. Each blocked file names the one variable that would unblock it.
4. Run the guide's first commands. With a Gemini key, `research_brief` is a good first template; with only an Anthropic key, `claude` is the shipped example; for any other provider, change a template's `model:` lines to that provider's ids and run the doctor again.

## What to tell them about the gateway

It is a fallback, never a preempt: a direct key set beside it wins for its provider. On the gateway path, native search is dropped (Gemini grounding, Anthropic and OpenAI `web_search`, xAI `x_search`), and long-term memory's embedder still needs `GOOGLE_GENAI_API_KEY` (or `MEMORY_EMBEDDING_PROVIDER=openai` or `ollama`). A model id the gateway rejects is fixed with `MODEL_GATEWAY_MODEL_MAP`, not in code.

## Sign in with ChatGPT (level 9, local only)

OpenAI documents a plan-usage sign-in for open-source apps that run on the user's own machine, and the engine implements it as its own app registration.

1. The person runs `npx melchizedek-setup --chatgpt-signin` (in a clone, `npm run setup -- --chatgpt-signin`) and approves in their own browser. You never see, copy or move the stored tokens; they live outside the repository, mode 600.
2. `OPENAI_API_KEY` must be blank for the sign-in to carry OpenAI ids; a key wins.
3. Run `npx melchizedek-doctor`: the providers line shows `ChatGPT sign-in, local only`, and the `chatgpt` line reads `signed in · carries OpenAI ids · local only`.
4. Point a syndicate's `model:` lines at a GPT id their ChatGPT account offers, then chat.

Tell them: it is a preview (the Responses API only, streamed, no temperature or output-token cap), their plan's usage limits apply, and it is for their machine only. `melchizedek-serve` and `melchizedek-worker` refuse to start on it; a server needs `OPENAI_API_KEY` or Azure OpenAI. Sign out with `--chatgpt-signout`.

## A subscription sign-in (level 10)

Say plainly what is and is not possible, then route:

- A Codex CLI login, a Claude.ai or a Gemini CLI sign-in pays for that vendor's own apps. The engine does not read, reuse or relay those tokens, and you must not wire one in or read their files.
- Anthropic and Google state that third-party software may not use those sign-ins. For OpenAI, the sanctioned way to use a ChatGPT plan is level 9, the engine's own Sign in with ChatGPT; copying the Codex CLI's token is not that flow.
- The sanctioned routes: an API key from the same vendor (level 2), or its cloud platform (Bedrock or Vertex AI for Claude, Vertex AI for Gemini, Azure OpenAI for GPT; level 5, `melchizedek-onboard-cloud`). Google AI Studio has a free tier, and local models need nothing (level 1).
- The sign-in still has a use here: it pays for the coding agent (you) that drives this repository.
