-- ============================================================================
-- 0022_typesafe_jev_pricing — price rows for TypeSafe Jev (extends ADR 0136;
--                             the provider is ADR 0144)
-- ============================================================================
-- Rows only, in 0017's column layout (USD per million tokens):
--   input_per_mtok        an input token
--   output_per_mtok       0: TypeSafe bills nothing for output today
--                         (docs.typesafe.ai/models, "output tokens are free")
--   cache_read_per_mtok   NULL: no cache on this API
--   cache_write_per_mtok  NULL
--
-- TypeSafe Jev (lib/models/jevAdapter.ts): $42 per billion input tokens,
-- which is $0.042 per million, the same on jev-1.14.0 and jev-1.13.0.
-- `jev-latest` and `jev-preview` are TypeSafe's aliases (both jev-1.14.0 on
-- 2026-10-23); a call made under an alias is priced under the alias, so the
-- aliases get rows too. Checked 2026-10-23 against docs.typesafe.ai/models.
--
-- Through a gateway (Vercel AI Gateway lists $0.042 input, max output 0;
-- OpenRouter bills "the rate on the Jev model page") the rate is the same
-- at the time of writing; an operator whose gateway adds a margin edits the
-- row.
--
-- New rows never overwrite a row that exists: an operator's own rates
-- survive. Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, verified_at, source, note) VALUES
  ('jev-latest',  0.042, 0, NULL, NULL, '2026-10-23', 'docs.typesafe.ai/models', 'TypeSafe first-party, checked 2026-10-23; alias of jev-1.14.0; output is free'),
  ('jev-preview', 0.042, 0, NULL, NULL, '2026-10-23', 'docs.typesafe.ai/models', 'TypeSafe first-party, checked 2026-10-23; alias of the newest build (jev-1.14.0); output is free'),
  ('jev-1.14.0',  0.042, 0, NULL, NULL, '2026-10-23', 'docs.typesafe.ai/models', 'TypeSafe first-party, checked 2026-10-23; output is free'),
  ('jev-1.13.0',  0.042, 0, NULL, NULL, '2026-10-23', 'docs.typesafe.ai/models', 'TypeSafe first-party, checked 2026-10-23; output is free')
ON CONFLICT (model) DO NOTHING;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (22, '0022_typesafe_jev_pricing')
ON CONFLICT (version) DO NOTHING;
