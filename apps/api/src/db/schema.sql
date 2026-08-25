-- Convertara metadata schema. Blobs live in object storage; this table set only
-- ever holds pointers, so the database stays small and cheap to back up.

CREATE TABLE IF NOT EXISTS jobs (
  id           UUID PRIMARY KEY,
  owner_id     TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed')),
  prompt       TEXT,
  plan         JSONB,
  plan_source  TEXT,
  input_file_ids  UUID[]   NOT NULL DEFAULT '{}',
  output_file_ids UUID[]   NOT NULL DEFAULT '{}',
  progress     REAL        NOT NULL DEFAULT 0,
  stage        TEXT,
  evaluation   JSONB,
  selection    JSONB,
  error        JSONB,
  timings      JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added after the table shipped, so it needs an ALTER as well as the CREATE
-- above: CREATE TABLE IF NOT EXISTS is a no-op on an existing database.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS selection JSONB;

CREATE INDEX IF NOT EXISTS jobs_owner_created_idx ON jobs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS files (
  id           UUID PRIMARY KEY,
  owner_id     TEXT        NOT NULL,
  job_id       UUID        REFERENCES jobs(id) ON DELETE SET NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('original','result')),
  filename     TEXT        NOT NULL,
  mime         TEXT        NOT NULL,
  bytes        BIGINT      NOT NULL,
  storage_key  TEXT        NOT NULL,
  checksum     TEXT        NOT NULL,
  meta         JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS files_job_idx ON files (job_id);
CREATE INDEX IF NOT EXISTS files_expiry_idx ON files (expires_at);

CREATE TABLE IF NOT EXISTS llm_configs (
  id                 UUID PRIMARY KEY,
  owner_id           TEXT        NOT NULL,
  label              TEXT        NOT NULL,
  provider           TEXT        NOT NULL,
  model              TEXT        NOT NULL,
  base_url           TEXT,
  api_key_ciphertext TEXT,
  temperature        REAL        NOT NULL DEFAULT 0.1,
  fallback_model     TEXT,
  is_default         BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_configs_owner_idx ON llm_configs (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS llm_configs_one_default_idx
  ON llm_configs (owner_id) WHERE is_default;

-- Conversations. Chat turns are stored so a follow-up like "now make it a PDF"
-- can resolve "it" to the file the previous turn produced.
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY,
  owner_id   TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_owner_idx ON conversations (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY,
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user','assistant')),
  text            TEXT        NOT NULL DEFAULT '',
  /* File ids the user attached, or that the assistant produced. */
  attachment_ids  UUID[]      NOT NULL DEFAULT '{}',
  job_id          UUID        REFERENCES jobs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);
