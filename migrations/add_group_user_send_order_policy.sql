-- Migration: samodzielna wysyłka zamówień przez konto podrzędne grupy
-- `group_user.send_order_policy` — ustawia grupa-matka w formularzu konta
-- (/group/shops/new, /group/shops/:id/edit):
--   1 — konto samo wysyła zamówienia,
--   0 — zamówienia czekają na zatwierdzenie w panelu grupy (dotychczasowe zachowanie).
-- Domyślnie 0, więc istniejące konta działają dokładnie jak przed migracją.
-- Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();
SET @tablename = 'group_user';

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = @tablename
  AND COLUMN_NAME = 'send_order_policy';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `group_user` ADD COLUMN send_order_policy TINYINT(1) NOT NULL DEFAULT 0 AFTER discount_percent',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
