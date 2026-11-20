-- Dynamic branding/theme config (logo, icon, brand name, custom CSS)
CREATE TABLE IF NOT EXISTS branding_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
