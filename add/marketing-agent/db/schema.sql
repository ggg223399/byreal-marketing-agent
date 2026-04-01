CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  -- Legacy v4 fields (kept for backwards compat, populated by v5 via mapping)
  pipeline TEXT NOT NULL CHECK (pipeline IN ('mentions', 'network', 'trends', 'crisis')),
  pipelines TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('reply', 'qrt', 'like', 'monitor', 'skip', 'statement')),
  angle TEXT,
  tones TEXT,  -- JSON array of ToneItem[] stored as string
  connection TEXT CHECK (connection IN ('direct', 'indirect', 'stretch') OR connection IS NULL),
  account_tier TEXT CHECK (account_tier IN ('O', 'S', 'A', 'B', 'C') OR account_tier IS NULL),
  severity TEXT CHECK (severity IN ('critical', 'high', 'medium') OR severity IS NULL),
  reason TEXT,
  source_adapter TEXT NOT NULL,
  raw_json TEXT,
  resolved_channels TEXT,  -- JSON array of routed channel names
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  notified_at INTEGER,
  -- v5 engine fields
  source_name TEXT,           -- v5 source name (mentions, ecosystem, narratives, crisis, etc.)
  alert_level TEXT,           -- Judge output: red/orange/yellow/none
  suggested_action TEXT,      -- Reactor output: reply_supportive/qrt_positioning/like_only/escalate_internal/none
  tone TEXT,                  -- First tone id (quick access, from tones[0].id)
  reply_angle TEXT,           -- Reactor output: 1-2 sentence creative direction for Generator
  judge_reasoning TEXT,       -- Judge output: reasoning text
  -- Enrichment fields
  enriched_at INTEGER,        -- Unix timestamp when metrics were backfilled
  enriched_metrics TEXT       -- JSON object with likes/retweets/replies/views
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'edit')),
  draft_text TEXT,
  final_text TEXT,
  approved_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (signal_id) REFERENCES signals(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS signal_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  feedback_type TEXT NOT NULL,
  feedback_by TEXT,
  source_name TEXT,
  alert_level TEXT,
  suggested_action TEXT,
  resolved_channels TEXT,
  tweet_id TEXT,
  snapshot_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (signal_id) REFERENCES signals(id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counter_type TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS config_overrides (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_signals_pipeline ON signals(pipeline);
CREATE INDEX IF NOT EXISTS idx_signals_action_type ON signals(action_type);
CREATE INDEX IF NOT EXISTS idx_signals_pipeline_created ON signals(pipeline, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_tweet_id ON signals(tweet_id);
CREATE INDEX IF NOT EXISTS idx_signals_source_name ON signals(source_name);
CREATE INDEX IF NOT EXISTS idx_signals_alert_level ON signals(alert_level);
CREATE INDEX IF NOT EXISTS idx_signals_enriched_at ON signals(enriched_at);

CREATE INDEX IF NOT EXISTS idx_approvals_signal_id ON approvals(signal_id);
CREATE INDEX IF NOT EXISTS idx_approvals_created_at ON approvals(created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_type ON audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

CREATE INDEX IF NOT EXISTS idx_signal_feedback_signal_id ON signal_feedback(signal_id);
CREATE INDEX IF NOT EXISTS idx_signal_feedback_type ON signal_feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_signal_feedback_created_at ON signal_feedback(created_at);

CREATE INDEX IF NOT EXISTS idx_rate_limits_type_window ON rate_limits(counter_type, window_start, window_end);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_limits_type_start ON rate_limits(counter_type, window_start);
