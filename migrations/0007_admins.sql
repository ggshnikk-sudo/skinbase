-- Appointed admins (GGSHNIKK is always super-admin and can manage this list)
CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
