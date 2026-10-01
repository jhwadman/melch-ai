-- ============================================================================
-- 0005_agent_registry — the agent registry, versioned (ADR 0018 items 4, 7)
-- ============================================================================
-- `adk_agent_registry` keeps its shape and stays the read path: one row per
-- id, `yaml_content` is the ACTIVE definition, so every server and publishing
-- tool written against it keeps working. What changes is that no write to it
-- can lose history:
--
--   * `adk_agent_registry_versions` is append-only: every definition an id
--     has ever held, numbered per id, with its config hash, author, note and
--     publish time. Updates and deletes are refused.
--   * A trigger on `adk_agent_registry` records the version on EVERY write,
--     whoever makes it (melchizedek-registry, an older deploy script, a
--     dashboard edit). Writing a definition an id already held re-activates
--     that version instead of adding a duplicate, so a rollback is just
--     writing the old content back, and melchizedek_registry_activate does
--     exactly that.
--   * Deleting the active row retires the id; its versions stay.
--
-- The author and note come from the transaction settings
-- `melchizedek.registry_author` / `melchizedek.registry_note`, which
-- melchizedek_registry_publish sets; a direct write records the database
-- role instead. The table holds agent definitions only: prompts and tool
-- lists, no user data. Existing rows become version 1 of their id.
-- Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS adk_agent_registry (
  id           TEXT PRIMARY KEY,
  yaml_content JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS version      INTEGER;
ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS config_hash  TEXT;
ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS published_by TEXT;
ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS adk_agent_registry_versions (
  id           TEXT        NOT NULL,
  version      INTEGER     NOT NULL,
  yaml_content JSONB       NOT NULL,
  config_hash  TEXT        NOT NULL,
  published_by TEXT        NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note         TEXT,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_adk_agent_registry_versions_hash
  ON adk_agent_registry_versions (id, config_hash);

-- jsonb's text form is canonical (keys sorted, whitespace fixed), so equal
-- definitions hash equal whatever tool wrote them.
CREATE OR REPLACE FUNCTION melchizedek_registry_hash(p_config jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(p_config::text, 'UTF8')), 'hex');
$$;

-- ── Every write to the active table records a version ────────────────────
CREATE OR REPLACE FUNCTION melchizedek_registry_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  h        text := melchizedek_registry_hash(NEW.yaml_content);
  existing integer;
  author   text := COALESCE(NULLIF(current_setting('melchizedek.registry_author', true), ''), session_user::text);
  note     text := NULLIF(current_setting('melchizedek.registry_note', true), '');
BEGIN
  -- An update that does not change the definition is not a publish.
  IF TG_OP = 'UPDATE' AND OLD.config_hash = h AND OLD.version IS NOT NULL THEN
    NEW.version := OLD.version;
    NEW.config_hash := h;
    RETURN NEW;
  END IF;

  -- Serialise publishes of one id, so two writers cannot take one number.
  PERFORM pg_advisory_xact_lock(hashtext('melchizedek_registry:' || NEW.id));

  SELECT version INTO existing
  FROM adk_agent_registry_versions
  WHERE id = NEW.id AND config_hash = h
  ORDER BY version DESC
  LIMIT 1;

  IF existing IS NULL THEN
    SELECT COALESCE(MAX(version), 0) + 1 INTO existing
    FROM adk_agent_registry_versions WHERE id = NEW.id;
    INSERT INTO adk_agent_registry_versions (id, version, yaml_content, config_hash, published_by, note)
    VALUES (NEW.id, existing, NEW.yaml_content, h, author, note);
  END IF;

  NEW.version      := existing;
  NEW.config_hash  := h;
  NEW.published_by := author;
  NEW.published_at := NOW();
  NEW.updated_at   := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_adk_agent_registry_record ON adk_agent_registry;
CREATE TRIGGER trg_adk_agent_registry_record
  BEFORE INSERT OR UPDATE ON adk_agent_registry
  FOR EACH ROW EXECUTE FUNCTION melchizedek_registry_record();

-- ── History is append-only ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION melchizedek_registry_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'adk_agent_registry_versions is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_adk_agent_registry_versions_immutable ON adk_agent_registry_versions;
CREATE TRIGGER trg_adk_agent_registry_versions_immutable
  BEFORE UPDATE OR DELETE ON adk_agent_registry_versions
  FOR EACH ROW EXECUTE FUNCTION melchizedek_registry_versions_immutable();

-- ── Publish and activate, with an author and a note ──────────────────────
-- Both return the version that is now active. Validation is the caller's:
-- the same schema the loader enforces (lib/registry.ts runs it first).
CREATE OR REPLACE FUNCTION melchizedek_registry_publish(
  p_id     text,
  p_config jsonb,
  p_author text,
  p_note   text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v integer;
BEGIN
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9_.-]{1,120}$' THEN
    RAISE EXCEPTION 'invalid registry id: %', p_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('melchizedek.registry_author', COALESCE(p_author, ''), true);
  PERFORM set_config('melchizedek.registry_note', COALESCE(p_note, ''), true);
  INSERT INTO adk_agent_registry (id, yaml_content) VALUES (p_id, p_config)
  ON CONFLICT (id) DO UPDATE SET yaml_content = EXCLUDED.yaml_content
  RETURNING version INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION melchizedek_registry_activate(
  p_id      text,
  p_version integer,
  p_author  text,
  p_note    text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cfg jsonb;
BEGIN
  SELECT yaml_content INTO cfg FROM adk_agent_registry_versions WHERE id = p_id AND version = p_version;
  IF cfg IS NULL THEN
    RAISE EXCEPTION 'no version % of registry id %', p_version, p_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN melchizedek_registry_publish(p_id, cfg, p_author, COALESCE(p_note, format('activate v%s', p_version)));
END;
$$;

-- ── Backfill: what is already live becomes version 1 ─────────────────────
-- The trigger does the recording; the update sets nothing that changes the
-- definition, so it only fires for rows that have no version yet.
DO $$
BEGIN
  PERFORM set_config('melchizedek.registry_author', 'migration 0005', true);
  PERFORM set_config('melchizedek.registry_note', 'the definition live when versioning began', true);
  UPDATE adk_agent_registry SET yaml_content = yaml_content WHERE version IS NULL;
END $$;

-- Locked down like every other table here; db/hardening.sql repeats it.
ALTER TABLE adk_agent_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_agent_registry_versions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON adk_agent_registry, adk_agent_registry_versions FROM anon, authenticated';
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (5, '0005_agent_registry')
ON CONFLICT (version) DO NOTHING;
