---
name: melchizedek-onboard-cloud
description: "Onboard a person to Melchizedek through their cloud account instead of vendor API keys: Gemini or Claude on Google Vertex AI (Application Default Credentials), Claude on Amazon Bedrock (the AWS credential chain), or GPT on Azure OpenAI (an Azure key or Entra ID). Use when someone has a Google Cloud project, AWS access, or an Azure OpenAI resource, needs data to stay in their cloud, or sees an endpoint problem from the doctor."
---

## The level

Level 5, `cloud-platform`. The model id still picks the provider; `GEMINI_PLATFORM`, `ANTHROPIC_PLATFORM` and `OPENAI_PLATFORM` pick the cloud it is reached through. Print the guide first:

```bash
npx melchizedek-setup --level cloud-platform     # in a clone: npm run setup -- --level cloud-platform
```

## Steps per cloud

The person signs in to their cloud with that cloud's own tools; you never handle the credential.

- **Gemini on Vertex AI.** They run `gcloud auth application-default login` (or the deployment uses a service account). In `.env`: `GEMINI_PLATFORM=vertex`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`.
- **Claude on Vertex AI.** `npm install @anthropic-ai/vertex-sdk`. In `.env`: `ANTHROPIC_PLATFORM=vertex`, `ANTHROPIC_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`), `CLOUD_ML_REGION` (or `GOOGLE_CLOUD_LOCATION`). Credentials are Google ADC, as above.
- **Claude on Amazon Bedrock.** `npm install @anthropic-ai/bedrock-sdk`. In `.env`: `ANTHROPIC_PLATFORM=bedrock`, `AWS_REGION`. Credentials come from the AWS chain (a profile, SSO, or the instance role). Bedrock model ids differ from Anthropic's: map them with `ANTHROPIC_MODEL_MAP` (a JSON object of YAML id to Bedrock id).
- **GPT on Azure OpenAI.** In `.env`: `OPENAI_PLATFORM=azure`, `AZURE_OPENAI_ENDPOINT`, and either `AZURE_OPENAI_API_KEY` or Entra ID (`npm install @azure/identity`, then `az login` or a managed identity). Map YAML ids to deployment names with `OPENAI_MODEL_MAP`.

Use `npx melchizedek-setup --level cloud-platform --write-env` to create `.env` with these names blank when there is none.

## Confirm

Run `npx melchizedek-doctor`. Each provider on a cloud prints one `endpoint` line; a ✗ names the missing variable or the uninstalled SDK. The doctor does not exercise the cloud's credential chain, so the first command is the real test:

```bash
npx melchizedek-init --template research_brief     # Gemini; for Claude use the claude example
npx melchizedek-chat --syndicate research_brief
```

## Say this up front

- These paths are tested against mocks and have not been run against the live clouds from the engine's repository; the doctor says so.
- Anthropic's and OpenAI's server-side `web_search` are not sent on Bedrock, Claude on Vertex AI or Azure. Gemini grounding works on Vertex AI.
- Model availability differs by region: a `Model not found` usually means the region or the model map, not the code.
