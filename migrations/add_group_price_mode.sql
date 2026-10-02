-- Migration: sposób wyceny klientów grupy typu `client` — rabat albo narzut.
--
-- `user.group_price_mode` — ustawia ADMIN w /admin/users (konto grupy,
-- `role = 'group'`, `group_type = 'client'`):
--   NULL / 'discount' — konto podrzędne widzi ceny `SUB___` z rabatem
--                       (`group_user.discount_percent`) — dotychczasowe zachowanie,
--   'markup'          — konto podrzędne widzi ceny ZWYKŁE powiększone o narzut
--                       (`group_user.markup_percent`).
--
-- `group_user.markup_percent` — narzut klienta grupy w procentach, nadawany przez
-- grupę-matkę w formularzu konta podrzędnego. Osobna kolumna, a nie drugie
-- znaczenie `discount_percent`: przełączenie trybu nie może po cichu zamienić
-- rabatu 60% w narzut 60% — każdy tryb pamięta własną wartość.
--
-- Domyślnie NULL / 0.00, więc istniejące konta działają dokładnie jak przed migracją.
-- Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'user'
  AND COLUMN_NAME = 'group_price_mode';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `user` ADD COLUMN group_price_mode VARCHAR(20) NULL DEFAULT NULL AFTER group_type',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'group_user'
  AND COLUMN_NAME = 'markup_percent';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `group_user` ADD COLUMN markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0.00 AFTER discount_percent',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
