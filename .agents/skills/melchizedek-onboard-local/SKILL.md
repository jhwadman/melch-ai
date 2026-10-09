---
name: melchizedek-onboard-local
description: "Onboard a person to Melchizedek with no API key at all: install Ollama, pull an open-weight model, and run the keyless syndicates entirely on their machine. Use when someone has no provider key, wants nothing to leave their machine, asks for the free or offline path, or meets OLLAMA_UNREACHABLE."
---

## The level

Level 1, `local`. Every agent whose model id starts with `ollama/` runs through Ollama's OpenAI-compatible endpoint on the person's machine. No account, no key. Print the current guide first:

```bash
npx melchizedek-setup --level local      # in a clone: npm run setup -- --level local
```

## Steps

1. Check Node.js: `node --version` must be 22.6 or newer.
2. The person installs Ollama from https://ollama.com (an installer is theirs to run). Then:

   ```bash
   ollama pull qwen3:8b
   ```

3. In a project that installed the package, copy the keyless template; in a clone, the keyless examples are already there:

   ```bash
   npx melchizedek-init --template conversational
   npx melchizedek-chat --syndicate conversational
   # clone: npm run syndicate:assistant (or syndicate:tutor, syndicate:council)
   ```

4. Confirm with the doctor (`npx melchizedek-doctor`, or `npm run doctor` in a clone): the providers line shows `Ollama (local) local`, and the keyless files read `ready — local, no key`.

## When it fails

- `OLLAMA_UNREACHABLE`: Ollama is not running. Start the app or `ollama serve`, then `ollama list` to see the model is pulled.
- An answer that stops mid-page on a summarizing task: Ollama's default context is 4,096 tokens. Restart it with `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`.
- A different Ollama host: set `OLLAMA_BASE_URL` (shape `http://host:11434/v1`) in `.env`. No key is involved.

## Next

Server-side search tools are not available locally. When the person gets a provider key, switch to `melchizedek-onboard-keys`; the keyless files keep working beside it.
