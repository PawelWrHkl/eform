-- Migration: waluta cen klienta (services/currency.js).
--
-- `organization.currency` — domyślna waluta klientów organizacji.
--   NULL = EUR (wszystkie organizacje poza wyjątkami poniżej).
-- `user.currency` — waluta KONKRETNEGO klienta, nadpisuje organizację.
--   NULL = jak organizacja. Miejsce na ustawienie per klient — dziś bez ekranu.
--
-- Kod ISO 4217 (CHAR(3)), obsługiwane kody: `CURRENCIES` w services/currency.js
-- (EUR, PLN). Kod spoza listy aplikacja pomija (wpis w logu) i liczy EUR.
--
-- Klienci organizacji LUXAN_EWA_KRAWCZYK (na bazie testowej `organization.id = 4`)
-- dostają PLN. Dopasowanie po `ident`, nie po id — id bywa inne między bazami.
-- `AND currency IS NULL`, żeby ponowne uruchomienie nie nadpisało późniejszej zmiany.
--
-- Waluta to na razie wyłącznie ETYKIETA: nic nie przelicza kwot.
-- Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'organization'
  AND COLUMN_NAME = 'currency';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `organization` ADD COLUMN currency CHAR(3) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'user'
  AND COLUMN_NAME = 'currency';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `user` ADD COLUMN currency CHAR(3) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `organization` SET currency = 'PLN'
WHERE ident = 'LUXAN_EWA_KRAWCZYK' AND currency IS NULL;
