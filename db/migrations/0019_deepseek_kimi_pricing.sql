-- ============================================================================
-- 0019_deepseek_kimi_pricing — price rows for DeepSeek and Moonshot Kimi
--                              (extends ADR 0136 and ADR 0139)
-- ============================================================================
-- Rows only, in 0017's column layout (USD per million tokens):
--   input_per_mtok        an input token that is not a cache hit
--   output_per_mtok       an output token (thinking included: NULL thinking
--                         rate, so thinking prices at the output rate)
--   cache_read_per_mtok   an input token read from the provider's cache
--   cache_write_per_mtok  NULL: neither vendor bills a cache write, so a
--                         written token prices as input
--
-- DeepSeek (lib/models/deepseekAdapter.ts): the PEAK rates. DeepSeek bills
-- off-peak at half, and peak (01:00–04:00 and 06:00–10:00 UTC on weekdays)
-- at exactly double the off-peak list; a flat row cannot say the hour, so
-- it holds the higher rate and a budget never underestimates a call.
-- Off-peak per 1M: deepseek-flash $0.15 in / $0.003 cache hit / $0.60 out;
-- deepseek-v4-pro $0.66 / $0.022 / $1.98. Checked 2026-10-22 against
-- api-docs.deepseek.com/quick_start/pricing. The retired deepseek-v4-flash
-- and deepseek-v4-flash-vision-exp ids are still accepted, served by
-- V4.1-Flash and billed at Flash's price, so they get Flash's row.
--
-- Moonshot Kimi (lib/models/kimiAdapter.ts): no row until now. The rates
-- are the family table in the adapter's header (platform.moonshot.ai ›
-- Model list, October 2026); verified_at stays NULL because this migration
-- did not re-check them against the vendor's list (0015's convention: spend
-- built on the row is a steering estimate until someone does).
--
-- New rows never overwrite a row that exists: an operator's own rates
-- survive. Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, verified_at, source, note) VALUES
  -- DeepSeek, peak rates (double the off-peak list).
  ('deepseek-flash',               0.30, 1.20, 0.006, NULL, '2026-10-22', 'api-docs.deepseek.com/quick_start/pricing', 'DeepSeek first-party, checked 2026-10-22; PEAK rate (01:00-04:00 and 06:00-10:00 UTC weekdays), double the off-peak $0.15 / $0.003 / $0.60, held so budgets never underestimate'),
  ('deepseek-v4-pro',              1.32, 3.96, 0.044, NULL, '2026-10-22', 'api-docs.deepseek.com/quick_start/pricing', 'DeepSeek first-party, checked 2026-10-22; PEAK rate (01:00-04:00 and 06:00-10:00 UTC weekdays), double the off-peak $0.66 / $0.022 / $1.98, held so budgets never underestimate'),
  ('deepseek-v4-flash',            0.30, 1.20, 0.006, NULL, '2026-10-22', 'api-docs.deepseek.com/quick_start/pricing', 'DeepSeek first-party, checked 2026-10-22; retired id served by V4.1-Flash and billed at Flash price; PEAK rate, double the off-peak $0.15 / $0.003 / $0.60'),
  ('deepseek-v4-flash-vision-exp', 0.30, 1.20, 0.006, NULL, '2026-10-22', 'api-docs.deepseek.com/quick_start/pricing', 'DeepSeek first-party, checked 2026-10-22; retired id served by V4.1-Flash and billed at Flash price; PEAK rate, double the off-peak $0.15 / $0.003 / $0.60'),
  -- Moonshot Kimi, from the family table in lib/models/kimiAdapter.ts.
  ('kimi-k3',                      3.00, 15.00, 0.30, NULL, NULL, 'platform.moonshot.ai (Model list, October 2026), via the family table in lib/models/kimiAdapter.ts', 'Moonshot first-party; not re-checked by this migration'),
  ('kimi-k2.6',                    0.95,  4.00, 0.16, NULL, NULL, 'platform.moonshot.ai (Model list, October 2026), via the family table in lib/models/kimiAdapter.ts', 'Moonshot first-party; not re-checked by this migration'),
  ('kimi-k2.7-code',               0.95,  4.00, 0.19, NULL, NULL, 'platform.moonshot.ai (Model list, October 2026), via the family table in lib/models/kimiAdapter.ts', 'Moonshot first-party; not re-checked by this migration'),
  ('kimi-k2.7-code-highspeed',     1.90,  8.00, 0.38, NULL, NULL, 'platform.moonshot.ai (Model list, October 2026), via the family table in lib/models/kimiAdapter.ts', 'Moonshot first-party; not re-checked by this migration')
ON CONFLICT (model) DO NOTHING;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (19, '0019_deepseek_kimi_pricing')
ON CONFLICT (version) DO NOTHING;
