-- Migration: fakturowanie niestandardowe klienta — faktura zbiorcza za okres.
--
-- `user.invoice_schedule` — ustawia ADMIN w /admin/users:
--   NULL / ''  — standard: osobna faktura za każde zlecenie wysłane do klienta
--                (!sent! w status.txt) — dotychczasowe zachowanie,
--   'weekly'   — jedna faktura zbiorcza ze wszystkich zleceń wysłanych w tygodniu
--                (poniedziałek–niedziela),
--   'monthly'  — jedna faktura zbiorcza ze wszystkich zleceń wysłanych w miesiącu.
-- Dotyczy faktur, w których ten użytkownik jest NABYWCĄ (poziom 2: organizacja →
-- klient). Wystawia je automat (services/invoices/autoInvoicing.js) po zamknięciu
-- okresu — patrz services/invoices/core/collective.js.
--
-- Domyślnie NULL, więc istniejące konta działają dokładnie jak przed migracją.
-- Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'user'
  AND COLUMN_NAME = 'invoice_schedule';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `user` ADD COLUMN invoice_schedule VARCHAR(10) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
