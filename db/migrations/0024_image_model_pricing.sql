-- ============================================================================
-- 0024_image_model_pricing — a price row for the image model generate_image
--                            calls (extends ADR 0136)
-- ============================================================================
-- Rows only, in 0017's column layout (USD per million tokens). generate_image
-- (lib/tools/generateImageTool.ts) now traces its call as an llm.request, so
-- the turn's usage holds gemini-3.1-flash-image-preview; without a row the
-- whole turn prices NULL.
--
-- gemini-3.1-flash-image-preview: Google's Gemini API pricing page
-- (aistudio.google.com/docs/pricing, checked 2026-11-06) lists the model as
-- gemini-3.1-flash-image, standard tier: $0.50 in, $3.00 text and thinking
-- out, $60.00 image out. The preview id is not on the page, so verified_at
-- stays NULL (0015's convention). A flat row has one output rate: it holds
-- the image rate, since nearly all of the call's output is the image, so the
-- few text tokens beside it are overcounted. Thinking bills at $3.00.
--
-- New rows never overwrite a row that exists: an operator's own rates
-- survive. Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok, thinking_per_mtok, cache_read_per_mtok, cache_write_per_mtok, verified_at, source, note) VALUES
  ('gemini-3.1-flash-image-preview', 0.50, 60.00, 3.00, NULL, NULL, NULL, 'aistudio.google.com/docs/pricing (as gemini-3.1-flash-image), checked 2026-11-06', 'output at the image rate; text output ($3.00) is overcounted; preview id not on the page')
ON CONFLICT (model) DO NOTHING;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (24, '0024_image_model_pricing')
ON CONFLICT (version) DO NOTHING;
