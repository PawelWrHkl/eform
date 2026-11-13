-- POP-02: adres dostawy klienta i wysyłka neutralna.
--   1. `delivery_address.is_default` — domyślny adres dostawy klienta (podstawiany
--      w nowym zleceniu; adres konta z `user` zostaje adresem fakturowym).
--   2. `send_address.neutral_shipping` — wysyłka neutralna do klienta końcowego
--      (bez nadawcy na etykiecie); idzie do PROD w JSON-ie jako `neutralShipping`.
-- Idempotentna (information_schema + PREPARE). Na produkcji uruchomić RAZEM
-- z `migration_phone_lengths.sql` — tam `send_address.phone` ma nadal VARCHAR(12)
-- i dłuższy telefon klienta końcowego wywracał zapis adresu.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'delivery_address' AND COLUMN_NAME = 'is_default';
SET @query = IF(@col_exists = 0,
  'ALTER TABLE `delivery_address` ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'send_address' AND COLUMN_NAME = 'neutral_shipping';
SET @query = IF(@col_exists = 0,
  'ALTER TABLE `send_address` ADD COLUMN neutral_shipping TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
