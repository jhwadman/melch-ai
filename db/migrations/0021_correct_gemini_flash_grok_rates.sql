-- ============================================================================
-- 0021_correct_gemini_flash_grok_rates — two seed rows to their vendors'
--                                        current lists (extends ADR 0136)
-- ============================================================================
-- 0015 seeded gemini-3.8-flash and grok-4.7 from melch-obs's pricing.toml as
-- unverified estimates. Checked 2026-10-22 against the vendors' lists, both
-- were wrong:
--
--   gemini-3.8-flash  ai.google.dev/gemini-api/docs/pricing (paid, standard):
--                     $0.75 in / $0.075 cached / $3.75 out, thinking billed
--                     as output, through 2026-12-31. Google has announced
--                     $1.50 / $0.15 / $7.50 from 2027-01-01; a flat row cannot
--                     say the date, so that needs its own row change then.
--                     Seed: $0.30 / $2.50 (a placeholder at 3.7's rate).
--   grok-4.7          docs.x.ai/docs/models: $2.00 in / $0.50 cached / $6.00
--                     out under 200k prompt tokens (a request of 200k or more
--                     bills $4.00 / $1.00 / $12.00 for all its tokens, which a
--                     flat row underestimates by half). Seed: $3.00 / $15.00.
--
-- A row changes only while it is still the seed: source melch-obs/pricing.toml,
-- verified_at NULL, and the seed's own rates. A rate an operator set is kept.
--
-- Rows already priced keep what they were priced at: the ledger records the
-- rate in force at write time (db/telemetry.sql). Re-pricing history is a
-- deliberate UPDATE, never a migration. Idempotent; safe to re-run.
-- ============================================================================

UPDATE model_pricing
   SET input_per_mtok = 0.75, output_per_mtok = 3.75, cache_read_per_mtok = 0.075,
       verified_at = '2026-10-22', source = 'ai.google.dev/gemini-api/docs/pricing',
       note = 'Gemini API paid standard tier, checked 2026-10-22; rate through 2026-12-31 (Google lists $1.50 / $0.15 / $7.50 from 2027-01-01)',
       updated_at = now()
 WHERE model = 'gemini-3.8-flash' AND source = 'melch-obs/pricing.toml' AND verified_at IS NULL
   AND input_per_mtok = 0.30 AND output_per_mtok = 2.50;

UPDATE model_pricing
   SET input_per_mtok = 2.00, output_per_mtok = 6.00, cache_read_per_mtok = 0.50,
       verified_at = '2026-10-22', source = 'docs.x.ai/docs/models',
       note = 'xAI first-party, checked 2026-10-22; rate under 200k prompt tokens (a request of 200k or more bills $4.00 / $1.00 / $12.00)',
       updated_at = now()
 WHERE model = 'grok-4.7' AND source = 'melch-obs/pricing.toml' AND verified_at IS NULL
   AND input_per_mtok = 3.00 AND output_per_mtok = 15.00;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (21, '0021_correct_gemini_flash_grok_rates')
ON CONFLICT (version) DO NOTHING;
