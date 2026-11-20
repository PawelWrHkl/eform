-- Migracja: płatnik i konto bankowe klienta z contractors.txt (Tomek, 19.11.2026: nowe kolumny
-- PAYMASTER_IDENT, BANK_NAME, BANK_ACCOUNT, SWIFT; „-” w pliku = brak).
--   user.paymaster_ident — ident konta płatnika: faktura idzie na jego dane (services/invoices/core/hierarchy.js)
--   user.bank_name / bank_account / swift — konto HKL, na które klient płaci (druk faktury, core/contractorAccounts.js)
-- Wypełnia services/dbUserSync.js (updateClients) — kod działa też bez migracji (pomija nowe pola).
-- Idempotentna: można uruchomić wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @c1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'paymaster_ident';
SET @q = IF(@c1 = 0, 'ALTER TABLE `user` ADD COLUMN paymaster_ident VARCHAR(50) NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @c2 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'bank_name';
SET @q = IF(@c2 = 0, 'ALTER TABLE `user` ADD COLUMN bank_name VARCHAR(160) NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @c3 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'bank_account';
SET @q = IF(@c3 = 0, 'ALTER TABLE `user` ADD COLUMN bank_account VARCHAR(42) NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @c4 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'swift';
SET @q = IF(@c4 = 0, 'ALTER TABLE `user` ADD COLUMN swift VARCHAR(20) NULL DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
