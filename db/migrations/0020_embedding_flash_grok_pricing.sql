-- ============================================================================
-- 0020_embedding_flash_grok_pricing — price rows for three models a ledger
--                                     already holds calls of (extends ADR 0136)
-- ============================================================================
-- Rows only, in 0017's column layout (USD per million tokens). A deployment's
-- ledger (penguin's, 2026-10-22) had calls of these three models priced NULL
-- because no row existed; scripts that re-price NULL rows can now fill them.
--
-- grok-4.3: xAI first-party, docs.x.ai/docs/models, checked 2026-10-22. The
-- row holds the rate under 200k prompt tokens ($1.25 in / $0.20 cached /
-- $2.50 out); a request of 200k or more is billed at double for all its
-- tokens ($2.50 / $0.40 / $5.00), which a flat row cannot say: such a call
-- is underestimated by half.
--
-- gemini-embedding-001: Google's GA announcement for the Gemini API
-- (developers.googleblog.com, "Gemini Embedding now generally available"):
-- $0.15 per 1M input tokens, no output tokens. Google's current pricing page
-- lists only its successor (gemini-embedding-2), so verified_at stays NULL.
--
-- gemini-3.5-flash: $1.50 in / $0.15 cached / $9.00 out, as two pricing
-- guides give it, one citing Google's Gemini API pricing documentation
-- (June 2026). Google's current page no longer lists the model (superseded
-- by 3.6 and 3.8 Flash), so this could not be checked against the vendor:
-- verified_at NULL, a steering estimate (0015's convention).
--
-- New rows never overwrite a row that exists: an operator's own rates
-- survive. Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, verified_at, source, note) VALUES
  ('grok-4.3',             1.25, 2.50, 0.20, NULL, '2026-10-22', 'docs.x.ai/docs/models', 'xAI first-party, checked 2026-10-22; rate under 200k prompt tokens (a request of 200k or more bills $2.50 / $0.40 / $5.00)'),
  ('gemini-embedding-001', 0.15, 0.00, NULL, NULL, NULL,         'developers.googleblog.com, Gemini Embedding now generally available in the Gemini API', 'Google first-party announcement; input only; no longer on the current pricing page (successor gemini-embedding-2), not re-checked'),
  ('gemini-3.5-flash',     1.50, 9.00, 0.15, NULL, NULL,         'eesel.ai Gemini 3 pricing guide (citing ai.google.dev pricing, June 2026), agreeing with other guides', 'unverified: off Google''s current pricing page (superseded by 3.6 and 3.8 Flash)')
ON CONFLICT (model) DO NOTHING;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (20, '0020_embedding_flash_grok_pricing')
ON CONFLICT (version) DO NOTHING;
