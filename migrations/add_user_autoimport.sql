-- Migration: per-client switch for the FTP order import (services/orderImport)
--
-- user.autoimport = 1 → an imported order is sent to production right away
--                       (the old behaviour, kept only for TCN);
-- user.autoimport = 0 → the order stays an unsent offer (status 'active') in
--                       the client's account until someone sends it.
-- Idempotent: safe to run more than once; the UPDATE only switches TCN on.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'user'
  AND COLUMN_NAME = 'autoimport';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `user` ADD COLUMN autoimport TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `user` SET autoimport = 1 WHERE ident = 'TCN';
