-- Migracja: hasło skrzynki fakturowej organizacji w bazie (Paweł, 17.11.2026: „wpisz do bazy
-- pole hasło do poczty — to musi być w każdej wersji, na produkcji też”).
-- organization.invoice_email_password — hasło do organization.invoice_email; robot faktur
-- (services/invoices/invoiceMailer.js) loguje się nim do skrzynki wystawcy. Zastępuje
-- INVOICE_SMTP_<IDENT>_PASSWORD z .env.local (zostaje jako zapas).
-- ⚠️ Samego hasła NIE wpisuj w tym pliku (repo jest w gicie) — osobny UPDATE ręcznie.
-- Wymaga add_organization_invoice_email.sql. Idempotentna: można uruchomić wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'organization'
  AND COLUMN_NAME = 'invoice_email_password';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE organization ADD COLUMN invoice_email_password VARCHAR(255) NULL DEFAULT NULL AFTER invoice_email',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
