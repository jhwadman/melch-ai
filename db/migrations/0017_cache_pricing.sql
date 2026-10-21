-- ============================================================================
-- 0017_cache_pricing — prompt-cache reads and writes at their own rates
--                      (ADR 0139, extends ADR 0136)
-- ============================================================================
-- model_pricing gains two rates, USD per million tokens:
--   cache_read_per_mtok   a token read from the provider's prompt cache
--   cache_write_per_mtok  a token written to it (Anthropic's 5-minute cache,
--                         the TTL the engine's requests get; OpenAI's 30-minute
--                         write where its price list names one)
-- NULL prices that token as input, which is what every row meant before:
-- a cache token is an input token (lib/models/contract.ts Usage counts both
-- inside inputTokens), so a row without cache rates prices exactly as 0015.
--
-- The cost functions take the two counts:
--   melchizedek_cost_usd(model, input, output, thinking, cache_read, cache_write)
--       input less both cache counts at the input rate, each cache count at
--       its rate, output, thinking at the thinking rate (else output's)
--   melchizedek_cost_usd(model, input, output, thinking)  the same with no
--       cache tokens, kept for a caller written against 0015
--   melchizedek_usage_cost(usage)  reads each model's cache_read and
--       cache_write beside input, output and thinking in syndicate.usage;
--       melchizedek_usage_text_cost (db/telemetry.sql) calls it, so the
--       ledger trigger prices a turn's cache tokens too.
--
-- The seed: rates checked against the vendors' own price lists on
-- 2026-10-20 (platform.claude.com/docs/en/about-claude/pricing and
-- developers.openai.com/api/docs/pricing, standard tier), with verified_at
-- set to that day. An Anthropic row 0015 seeded gains its cache rates only
-- while it still holds 0015's input and output rates and no cache rate: an
-- operator's own rates are never overwritten. New rows never overwrite a
-- row that exists. Models the engine names but the lists price by prompt
-- length beyond a flat row (claude-haiku-5-5, gpt-5.5 and gpt-5.4 over
-- 272K) are left as noted below. Gemini, Grok and Kimi rows get no cache
-- rates here (none was checked): their cache tokens price as input.
--
-- Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS cache_read_per_mtok  NUMERIC CHECK (cache_read_per_mtok >= 0);
ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS cache_write_per_mtok NUMERIC CHECK (cache_write_per_mtok >= 0);

-- Anthropic: the rows 0015 seeded, at the rates it seeded them.
UPDATE model_pricing p
SET cache_read_per_mtok  = s.cache_read,
    cache_write_per_mtok = s.cache_write,
    verified_at = '2026-10-20',
    source = 'platform.claude.com/docs/en/about-claude/pricing',
    note = 'Anthropic first-party, checked 2026-10-20; cache write is the 5-minute rate',
    updated_at = now()
FROM (VALUES
  ('claude-fable-5-1',  10.00, 50.00, 0.25, 12.50),
  ('claude-fable-5',    10.00, 50.00, 1.00, 12.50),
  ('claude-opus-5',      5.00, 25.00, 0.50,  6.25),
  ('claude-opus-4-8',    5.00, 25.00, 0.50,  6.25),
  ('claude-opus-4-7',    5.00, 25.00, 0.50,  6.25),
  ('claude-opus-4-6',    5.00, 25.00, 0.50,  6.25),
  ('claude-sonnet-5',    2.00, 10.00, 0.20,  2.50),
  ('claude-sonnet-4-6',  3.00, 15.00, 0.30,  3.75),
  ('claude-haiku-4-5',   1.00,  5.00, 0.10,  1.25)
) AS s(model, input, output, cache_read, cache_write)
WHERE p.model = s.model
  AND p.input_per_mtok = s.input
  AND p.output_per_mtok = s.output
  AND p.cache_read_per_mtok IS NULL
  AND p.cache_write_per_mtok IS NULL;

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, verified_at, source, note) VALUES
  -- Anthropic models 0015 did not seed. claude-haiku-5-5 is left out: its
  -- price doubles past a 100K-token prompt, which a flat row cannot say.
  ('claude-opus-5-5',    4.00, 20.00, 0.20, 5.00, '2026-10-20', 'platform.claude.com/docs/en/about-claude/pricing', 'Anthropic first-party, checked 2026-10-20; cache write is the 5-minute rate'),
  ('claude-sonnet-5-5',  2.00, 10.00, 0.10, 2.50, '2026-10-20', 'platform.claude.com/docs/en/about-claude/pricing', 'Anthropic first-party, checked 2026-10-20; cache write is the 5-minute rate'),
  -- OpenAI, standard tier. Reasoning tokens bill as output (thinking NULL).
  -- A NULL cache write: the list names no write rate, so a write prices as input.
  ('gpt-6-astra',       10.00, 50.00, 1.00,  12.50, '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-6.1-sol',        2.00, 10.00, 0.10,  2.50,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-6-sol',          2.00, 10.00, 0.20,  2.50,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-6-luna',         0.10,  0.50, 0.01,  0.125, '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-5.6-sol',        4.00, 20.00, 0.40,  5.00,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-5.6-terra',      2.00, 12.00, 0.20,  2.50,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-5.6-luna',       0.20,  1.20, 0.02,  0.25,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; cache write is the 30-minute rate'),
  ('gpt-5.5',            5.00, 30.00, 0.50,  NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; the rate for prompts under 272K tokens'),
  ('gpt-5.4',            2.50, 15.00, 0.25,  NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20; the rate for prompts under 272K tokens'),
  ('gpt-5.2',            1.75, 14.00, 0.175, NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20'),
  ('gpt-5.1',            1.25, 10.00, 0.125, NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20'),
  ('gpt-5',              1.25, 10.00, 0.125, NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20'),
  ('gpt-5-mini',         0.25,  2.00, 0.025, NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20'),
  ('gpt-5-nano',         0.05,  0.40, 0.005, NULL,  '2026-10-20', 'developers.openai.com/api/docs/pricing', 'OpenAI standard tier, checked 2026-10-20')
ON CONFLICT (model) DO NOTHING;

-- The row that prices `model`: its own, else its prefix's `<prefix>/*`.
CREATE OR REPLACE FUNCTION melchizedek_cost_usd(model TEXT, input BIGINT, output BIGINT, thinking BIGINT, cache_read BIGINT, cache_write BIGINT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (greatest(coalesce(input, 0) - coalesce(cache_read, 0) - coalesce(cache_write, 0), 0) * p.input_per_mtok
          + coalesce(cache_read, 0) * coalesce(p.cache_read_per_mtok, p.input_per_mtok)
          + coalesce(cache_write, 0) * coalesce(p.cache_write_per_mtok, p.input_per_mtok)
          + coalesce(output, 0) * p.output_per_mtok
          + coalesce(thinking, 0) * coalesce(p.thinking_per_mtok, p.output_per_mtok)) / 1000000
  FROM model_pricing p
  WHERE p.model = melchizedek_cost_usd.model
     OR (position('/' IN melchizedek_cost_usd.model) > 0
         AND p.model = split_part(melchizedek_cost_usd.model, '/', 1) || '/*')
  ORDER BY (p.model = melchizedek_cost_usd.model) DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION melchizedek_cost_usd(model TEXT, input BIGINT, output BIGINT, thinking BIGINT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT melchizedek_cost_usd(model, input, output, thinking, 0::bigint, 0::bigint)
$$;

CREATE OR REPLACE FUNCTION melchizedek_usage_cost(usage JSONB)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN usage IS NULL OR jsonb_typeof(usage) <> 'object' THEN NULL
    -- bool_and over no rows is NULL: a turn that made no model call costs nothing.
    WHEN coalesce(bool_and(c.cost IS NOT NULL), true) THEN coalesce(sum(c.cost), 0)
    ELSE NULL
  END
  FROM (
    SELECT melchizedek_cost_usd(
             e.key,
             CASE WHEN jsonb_typeof(e.value->'input') = 'number' THEN (e.value->>'input')::numeric::bigint END,
             CASE WHEN jsonb_typeof(e.value->'output') = 'number' THEN (e.value->>'output')::numeric::bigint END,
             CASE WHEN jsonb_typeof(e.value->'thinking') = 'number' THEN (e.value->>'thinking')::numeric::bigint END,
             CASE WHEN jsonb_typeof(e.value->'cache_read') = 'number' THEN (e.value->>'cache_read')::numeric::bigint END,
             CASE WHEN jsonb_typeof(e.value->'cache_write') = 'number' THEN (e.value->>'cache_write')::numeric::bigint END
           ) AS cost
    FROM jsonb_each(CASE WHEN jsonb_typeof(usage) = 'object' THEN usage ELSE '{}'::jsonb END) e
  ) c
$$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (17, '0017_cache_pricing')
ON CONFLICT (version) DO NOTHING;
