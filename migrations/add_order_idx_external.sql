-- Migration: order numbers taken over from the importing client (`orderno`)
--
-- The FTP import stores the client's own order number in `order.order_idx`
-- (services/orderImport). Those numbers live in the client's range (TCN sends
-- 272905, …), so the `before_insert_order` trigger must not count them when it
-- numbers the next order the same client creates by hand — otherwise that
-- order would get 272906, the number the client is about to send itself.
--
-- `order_idx_external = 1` marks such a number; the trigger skips those rows.
-- Idempotent: safe to run more than once. No DELIMITER needed — the trigger is
-- a single statement, so this also runs through mysql2 with multipleStatements.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'order'
  AND COLUMN_NAME = 'order_idx_external';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN order_idx_external TINYINT(1) NOT NULL DEFAULT 0 AFTER order_idx',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Same numbering as migration_group_shop_order_idx.sql, minus external numbers.
DROP TRIGGER IF EXISTS `before_insert_order`;

CREATE TRIGGER `before_insert_order`
BEFORE INSERT ON `order`
FOR EACH ROW
SET NEW.order_idx = IF(
  NEW.order_idx IS NULL OR NEW.order_idx = '',
  (SELECT CAST(COALESCE(MAX(CAST(o.order_idx AS UNSIGNED)), 0) + 1 AS CHAR)
     FROM `order` o
    WHERE o.user_id = NEW.user_id
      AND o.group_user_id IS NULL
      AND o.order_idx_external = 0
      AND o.order_idx REGEXP '^[0-9]+$'),
  NEW.order_idx
);
