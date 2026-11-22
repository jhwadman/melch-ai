-- ============================================================================
-- 0027_gemini_4_pricing — a price row for gemini-4-hydrogen (extends ADR 0136)
-- ============================================================================
-- Rows only, in 0017's column layout (USD per million tokens). The engine's
-- defaults and shipped syndicates name gemini-4-hydrogen (ADR 0160); without
-- a row a turn that calls it prices NULL, and so does the whole turn.
--
-- gemini-4-hydrogen: ai.google.dev/gemini-api/docs/pricing (paid, standard
-- tier), checked 2026-11-19: $1.50 in / $0.075 cached / $7.50 out, thinking
-- billed as output.
--
-- gemini-3.8-flash keeps its row (0021): ledger rows written on it still
-- price. Google lists its rate at $1.50 / $0.15 / $7.50 from 2027-01-01; that
-- change is a later migration, dated when the rate changes.
--
-- New rows never overwrite a row that exists: an operator's own rates
-- survive. Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, thinking_per_mtok, cache_read_per_mtok, cache_write_per_mtok, verified_at, source, note) VALUES
  ('gemini-4-hydrogen', 1.50, 7.50, NULL, 0.075, NULL, '2026-11-19', 'ai.google.dev/gemini-api/docs/pricing', 'Gemini API paid standard tier, checked 2026-11-19; thinking billed as output')
ON CONFLICT (model) DO NOTHING;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (27, '0027_gemini_4_pricing')
ON CONFLICT (version) DO NOTHING;
