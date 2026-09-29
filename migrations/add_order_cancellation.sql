-- Migration: anulowanie wysłanego zlecenia przez klienta (do 24 h od wysłania)
-- Status `canceled` mieści się w istniejącej kolumnie `order.status` (VARCHAR(30)),
-- więc dochodzą wyłącznie kolumny audytowe:
--   canceled_at — kiedy zlecenie anulowano (czas warszawski, jak `sent_date`),
--   canceled_by — kto anulował (np. `user:ryver`, `employee:12`, `admin:admin`).
-- ⚠️ `sent_date` przy anulowaniu zostaje NIETKNIĘTA — od niej liczy się okno 24 h
-- i to ona mówi, kiedy zlecenie poszło na produkcję. Patrz services/orderCancellation.js.
-- Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();
SET @tablename = 'order';

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = @tablename
  AND COLUMN_NAME = 'canceled_at';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN canceled_at DATETIME NULL DEFAULT NULL AFTER corrected_at',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = @tablename
  AND COLUMN_NAME = 'canceled_by';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN canceled_by VARCHAR(100) NULL DEFAULT NULL AFTER canceled_at',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
