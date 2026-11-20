-- Метаданные кадров больше не храним: стек режет сам мод капов на стороне клиента,
-- ему настройки вроде FPS/размера кадра от нас не нужны (мы только склеиваем кадры).

ALTER TABLE animated DROP COLUMN frames;
ALTER TABLE animated DROP COLUMN frame_w;
ALTER TABLE animated DROP COLUMN frame_h;