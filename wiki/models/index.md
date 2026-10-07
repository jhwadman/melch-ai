# Models

<!-- wiki:generated section="listing" source="directory contents" -->
- [Model contract](/models/model-contract.md) — The engine's own model contract (lib/models/contract.ts): every field of the message, request, response and adapter types and why it exists, how each field maps to the wire for Gemini, Anthropic, OpenAI Responses, xAI, Moonshot, Ollama and the gateway, and how it maps to and from @google/genai Content (lib/models/genaiMapping.ts).
- [Provider routing](/models/provider-routing.md) — How a model string in YAML reaches the right provider adapter: one prefix table, six providers, availability by API key.
<!-- /wiki:generated -->
