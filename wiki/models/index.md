# Models

<!-- wiki:generated section="listing" source="directory contents" -->
- [ADK shim](/models/adk-shim.md) — AdkShim (lib/models/adkShim.ts): one ADK BaseLlm that runs any ModelAdapter on the engine's contract, so adapters move onto the contract while ADK still runs every turn. What it maps, the turn charge, abort signal and llm.request span it owns for every adapter behind it, how to construct and register one, and how the boundary suite holds it to the scripted ADK model.
- [Gemini adapter](/models/gemini-adapter.md) — GeminiAdapter (lib/models/geminiAdapter.ts): Gemini behind the engine's model contract on @google/genai directly, with no ADK in the path. How it reaches the Gemini API or Vertex AI, the choices it makes inside the contract's Gemini mapping, thought signatures, failures, and what only a live run can confirm.
- [Model contract](/models/model-contract.md) — The engine's own model contract (lib/models/contract.ts): every field of the message, request, response and adapter types and why it exists, how each field maps to the wire for Gemini, Anthropic, OpenAI Responses, xAI, Moonshot, Ollama and the gateway, and how it maps to and from @google/genai Content (lib/models/genaiMapping.ts).
- [Provider routing](/models/provider-routing.md) — How a model string in YAML reaches the right provider adapter: one prefix table, six providers, availability by API key.
<!-- /wiki:generated -->
