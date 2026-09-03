CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('episodic', 'semantic', 'procedural', 'feedback')),
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'agent', 'system')),
  category TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  usage_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  provenance JSONB,
  metadata JSONB,
  embedding vector(1536),
  embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'ready', 'failed')),
  embedding_attempts INTEGER NOT NULL DEFAULT 0,
  embedding_last_error TEXT
);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_last_error TEXT;

CREATE TABLE IF NOT EXISTS memory_embedding_outbox (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed', 'completed')),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_embedding_outbox_ready_idx
  ON memory_embedding_outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS memories_project_status_idx
  ON memories(project_id, status);

CREATE INDEX IF NOT EXISTS memories_project_kind_idx
  ON memories(project_id, kind, status);

CREATE INDEX IF NOT EXISTS memories_tags_idx
  ON memories USING GIN(tags);

CREATE INDEX IF NOT EXISTS memories_metadata_idx
  ON memories USING GIN(metadata);

CREATE INDEX IF NOT EXISTS memories_conflict_key_idx
  ON memories(project_id, ((metadata->>'conflictKey')))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx
  ON memories USING hnsw (embedding vector_cosine_ops);
