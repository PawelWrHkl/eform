-- Migracja: termin płatności klienta z contractors.txt (kolumna PAYMENT_DAYS — Paweł 20.11.2026, „jedno i drugie”).
--   user.payment_days — liczba dni od daty wystawienia; NULL = brak (puste albo „-” w pliku).
-- Termin faktury (services/invoices/main.js): ręczna zmiana → płatnik (PAYMASTER_IDENT) → klient →
-- organizacja-nabywca (poziom 1: konto organizacji w contractors.txt, np. Cozy, LuxanGmbH) → wystawca → 14.
-- Wypełnia services/dbUserSync.js (updateClients) — kod działa też bez migracji (pomija kolumnę),
-- a plik bez kolumny PAYMENT_DAYS niczego nie kasuje.
-- Idempotentna: można uruchomić wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @c1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'payment_days';
SET @q = IF(@c1 = 0, 'ALTER TABLE `user` ADD COLUMN payment_days INT NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
