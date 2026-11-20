-- Миграция на v3: формат «только плащи».
-- 1. Сохраняем удаляемые скины (персонажи, элитры) в бэкапы по каждому юзеру —
--    JSON со ссылками отдаётся юзеру при первом заходе (см. /api/v3/backup).
-- 2. Удаляем несовместимые скины и снимаем их с экипировки.

CREATE TABLE IF NOT EXISTS skin_backups (
  user_id INTEGER PRIMARY KEY,
  backup_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO skin_backups (user_id, backup_json)
SELECT user_id, json_group_array(json_object(
  'id', id,
  'name', name,
  'category', category,
  'value', value,
  'tags', tags
))
FROM skins
WHERE category IN ('character', 'elytra')
GROUP BY user_id;

DELETE FROM skins WHERE category IN ('character', 'elytra');

UPDATE equipped SET character_skin_id = NULL, elytra_skin_id = NULL;
