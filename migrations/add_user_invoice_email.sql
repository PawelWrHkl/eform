-- Migracja: adres do faktur klienta z contractors.txt (kolumna INVOICE_EMAIL — Wiktoria/Tomek, 19.11.2026).
-- PROD wysyła faktury na adres z CONTRACTORDOCCONF (organizacja, rodzaj dokumentu 1 = faktura), a bez niego
-- na CONTRACTOR.EMAIL2; EMAIL z contractors.txt to adres logowania, nie do faktur.
--   user.invoice_email — e-faktura ZUGFeRD: `buyer.invoice_email` (services/invoices/einvoice/payload.js)
-- Wypełnia services/dbUserSync.js (updateClients) — kod działa też bez migracji (pomija kolumnę),
-- a plik bez kolumny INVOICE_EMAIL niczego nie kasuje. „-” w pliku = brak.
-- Idempotentna: można uruchomić wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @c1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'invoice_email';
SET @q = IF(@c1 = 0, 'ALTER TABLE `user` ADD COLUMN invoice_email VARCHAR(255) NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
