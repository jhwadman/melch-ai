---
type: decision
title: "ADR 0145: The gateway can be preferred over a direct key, with per-provider exceptions"
description: "MODEL_GATEWAY_PREFER=gateway sends every cloud id through the configured gateway even beside its direct key, and MODEL_GATEWAY_EXCEPT names the providers that take the opposite of the preference either way; unset, ADR 0012's rule holds; Ollama and an A2A caller's own key stay direct."
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-23
sources:
  - resource: lib/models/gateway.ts
  - resource: lib/models/registry.ts
  - resource: lib/onboarding.ts
  - resource: tests/gateway.test.ts
---

# ADR 0145: The gateway can be preferred over a direct key, with per-provider exceptions

**Decided (2026-10-23):** The transport rule gains a preference. `MODEL_GATEWAY_PREFER` is `direct` (the default: a provider's own key wins and the gateway fills what is absent, as ADR 0012 decided) or `gateway` (every cloud id goes through the configured gateway even beside its direct key, so one account is billed and one dashboard shows every call, at the gateway's fidelity). `MODEL_GATEWAY_EXCEPT` is a comma list of provider ids that take the opposite of the preference either way, so Gemini can stay on its own key for grounding under `prefer=gateway`, or Grok alone can go through the gateway under the default. Two things never move: `ollama/*` is always direct, and an A2A caller's own key funds its provider directly, since that is what the caller asked for. A preferred path that is not funded falls back to the other, so setting the preference with no usable gateway changes nothing. Both variables are read through the credential source like the key (ADR 0133), so an embedding application's keychain can set them; `providerStatuses`, the capability report and the doctor follow the same `providerTransport`, and a misspelt preference or an unknown provider in the list is named as a gateway problem, never routed silently.

**Instead of:** keeping the rule absolute (a person who wants one bill would have to remove keys they also need for memory embeddings); a per-agent `transport:` key in the YAML (the file names models, not paths; the same file must run on any deployment); a gateway prefix on the model id (ADR 0012 rejected it, and it would make the transport a provider); exceptions that only ever force the gateway (the symmetric list covers both directions with one variable)
**Supersedes:** [ADR 0012](/decisions/0012-direct-adapters-canonical.md) (the "always": the direct-first rule is now the default, not the only behaviour)
**Open:** a per-syndicate or per-agent exception, should a deployment want one file's agents on the gateway and another's direct; whether the doctor should warn when `prefer=gateway` drops native search an agent declares (today it reports the drop as it does for any gateway path)

How it works: [Provider routing](/models/provider-routing.md#transport-direct-by-default-a-gateway-only-for-what-is-absent)
