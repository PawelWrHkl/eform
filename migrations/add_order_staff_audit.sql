-- Migration: audyt pracy biura na zleceniu.
--   order.created_by_staff_id — konto biura (`user.id`, rola `staff`), które założyło zlecenie;
--   order.updated_by_staff_id — konto biura, które ostatnio zmieniło zlecenie lub jego pozycje.
-- NULL = zlecenie bez udziału biura. Widoczne tylko dla biura i admina; nie trafia
-- do PDF-ów, maili ani eksportu FTP (db/orders.js getOrderDataToSend wybiera kolumny jawnie).
-- Bez klucza obcego, jak `order.user_id` — usunięcie konta biura nie może blokować zleceń.
-- Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();
SET @tablename = 'order';

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = @tablename
  AND COLUMN_NAME = 'created_by_staff_id';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN created_by_staff_id INT NULL DEFAULT NULL AFTER created_by_group_user_id',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = @tablename
  AND COLUMN_NAME = 'updated_by_staff_id';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN updated_by_staff_id INT NULL DEFAULT NULL AFTER created_by_staff_id',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @idx_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = @tablename
  AND INDEX_NAME = 'idx_order_created_by_staff';

SET @query = IF(@idx_exists = 0,
  'ALTER TABLE `order` ADD INDEX idx_order_created_by_staff (created_by_staff_id)',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
