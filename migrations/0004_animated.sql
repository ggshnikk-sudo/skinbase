-- Анимированные капы (Stacked PNG) — отдельный блок, не смешиваем с обычными.
-- Мод может держать одновременно обычный кап (skins/equipped) И анимированный
-- (animated/animated_equipped) — выбор «что показывать» остаётся за конфигом мода.

-- Анимированные капы: файл — Stacked PNG (кадры друг под другом) на CatBox.
CREATE TABLE IF NOT EXISTS animated (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  -- Метаданные стека: количество кадров и размер одного кадра.
  -- Моды используют их, чтобы разрезать стек на кадры строго по типу плаща.
  frames INTEGER NOT NULL DEFAULT 1,
  frame_w INTEGER NOT NULL DEFAULT 64,
  frame_h INTEGER NOT NULL DEFAULT 32,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Второй слот экипировки: анимированный плащ (независим от equipped.cape_skin_id).
CREATE TABLE IF NOT EXISTS animated_equipped (
  user_id INTEGER PRIMARY KEY,
  animated_skin_id INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (animated_skin_id) REFERENCES animated(id) ON DELETE SET NULL
);