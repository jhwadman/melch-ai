-- ============================================================================
-- 0015_model_pricing — what a model call costs, so the ledger records dollars
--                      (ADR 0136)
-- ============================================================================
-- model_pricing: USD per million tokens, one row per model id as the YAML
-- declares it (`claude-opus-5`, `gemini-3.8-flash`, `grok-4.7`). A row whose
-- id ends in `/*` prices every id under that prefix (`ollama/*`: local
-- models cost nothing). `thinking_per_mtok` NULL means thinking bills at the
-- output rate, as every provider here bills it. `verified_at` NULL means
-- nobody has checked the row against the vendor's price list: spend built on
-- it is a steering estimate (the convention ymir_model_pricing set).
--
-- Seeded from melch-obs's pricing.toml (2026-10). The seed never overwrites a
-- row: an operator's own rates survive a re-run. A rate change ships as a
-- later migration that UPDATEs the row and its verified_at.
--
-- The cost functions below are what db/telemetry.sql's ledger trigger calls
-- to fill adk_turns.cost_usd and adk_telemetry.cost_usd at write time:
--   melchizedek_cost_usd(model, input, output, thinking)  one call's cost,
--       NULL for a model with no row
--   melchizedek_usage_cost(usage)  a turn's cost from its per-model usage
--       ({"<model>": {"input": n, "output": n, "thinking": n}}), NULL when
--       any model in it has no row: a partial sum would read as the total.
-- Ledger output_tokens exclude thinking (genaiMapping's usage meaning), so
-- thinking is priced on top of output.
--
-- Nothing secret, nothing personal; hardening.sql closes it to the API roles
-- like every other table. Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_pricing (
  model              TEXT PRIMARY KEY,
  input_per_mtok     NUMERIC NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok    NUMERIC NOT NULL CHECK (output_per_mtok >= 0),
  thinking_per_mtok  NUMERIC CHECK (thinking_per_mtok >= 0),
  verified_at        TIMESTAMPTZ,
  source             TEXT,
  note               TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, verified_at, source, note) VALUES
  -- Anthropic first-party rates; pricing.toml dates the check to the month (2026-06).
  ('claude-fable-5-1',      10.00, 50.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-fable-5',        10.00, 50.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-opus-5',          5.00, 25.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-opus-4-8',        5.00, 25.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-opus-4-7',        5.00, 25.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-opus-4-6',        5.00, 25.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-sonnet-5',        2.00, 10.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-sonnet-4-6',      3.00, 15.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('claude-haiku-4-5',       1.00,  5.00, '2026-06-01', 'melch-obs/pricing.toml', 'Anthropic first-party, checked 2026-06'),
  ('gemini-3.5-flash-lite',  0.30,  2.50, '2026-10-01', 'melch-obs/pricing.toml', 'Gemini API standard tier, checked 2026-10-01'),
  -- Carried over from ymir_model_pricing, never checked against a vendor list.
  ('gemini-3.1-flash-lite',  0.10,  0.40, NULL, 'melch-obs/pricing.toml', 'unverified estimate'),
  ('gemini-3.7-flash',       0.30,  2.50, NULL, 'melch-obs/pricing.toml', 'unverified estimate'),
  ('gemini-3.8-flash',       0.30,  2.50, NULL, 'melch-obs/pricing.toml', 'placeholder at 3.7''s rate, unverified'),
  ('grok-4.5',               3.00, 15.00, NULL, 'melch-obs/pricing.toml', 'unverified estimate'),
  ('grok-4.7',               3.00, 15.00, NULL, 'melch-obs/pricing.toml', 'unverified estimate'),
  -- A local model bills nothing; that needs no vendor list.
  ('ollama/*',               0,     0,    '2026-10-15', 'engine', 'local models: no provider charge')
ON CONFLICT (model) DO NOTHING;

-- The row that prices `model`: its own, else its prefix's `<prefix>/*`.
CREATE OR REPLACE FUNCTION melchizedek_cost_usd(model TEXT, input BIGINT, output BIGINT, thinking BIGINT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (coalesce(input, 0) * p.input_per_mtok
          + coalesce(output, 0) * p.output_per_mtok
          + coalesce(thinking, 0) * coalesce(p.thinking_per_mtok, p.output_per_mtok)) / 1000000
  FROM model_pricing p
  WHERE p.model = melchizedek_cost_usd.model
     OR (position('/' IN melchizedek_cost_usd.model) > 0
         AND p.model = split_part(melchizedek_cost_usd.model, '/', 1) || '/*')
  ORDER BY (p.model = melchizedek_cost_usd.model) DESC
  LIMIT 1
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
             CASE WHEN jsonb_typeof(e.value->'thinking') = 'number' THEN (e.value->>'thinking')::numeric::bigint END
           ) AS cost
    FROM jsonb_each(CASE WHEN jsonb_typeof(usage) = 'object' THEN usage ELSE '{}'::jsonb END) e
  ) c
$$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (15, '0015_model_pricing')
ON CONFLICT (version) DO NOTHING;
