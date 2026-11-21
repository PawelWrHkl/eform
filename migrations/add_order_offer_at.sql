-- Migracja: znacznik „oferta” (Paweł 20.11.2026, „tak, dodać znacznik”).
--   order.offer_at — chwila PIERWSZEGO zdarzenia oferty (czas jak created_date, Europe/Warsaw):
--   import FTP na koncie z autoimport = 0, PDF aktywnego zlecenia, PDF specyfikacji ceny
--   (services/orderOffer.js). Wysyłka go nie czyści — z tego liczy się konwersja oferta → zlecenie
--   w raporcie organizacji (/org/reports, services/orgReports.js).
-- Kod działa bez migracji: brak kolumny = brak sekcji ofert i brak znacznika.
-- Uzupełnienie wstecz (import_log): scripts/backfillOrderOfferAt.js (--dry-run).
-- Idempotentna: można uruchomić wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @c1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND COLUMN_NAME = 'offer_at';
SET @q = IF(@c1 = 0, 'ALTER TABLE `order` ADD COLUMN offer_at DATETIME NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
