-- Migracja: adres fakturowy organizacji (Paweł, 17.11.2026:
-- „każda organizacja musi mieć swój adres fakturowy i z niego idzie mail do klienta").
-- organization.invoice_email — skrzynka, z której robot wysyła maile z fakturami
-- wystawcy (services/invoices/invoiceMailer.js). Hasło skrzynki NIE w bazie:
-- INVOICE_SMTP_<IDENT>_PASSWORD w .env.local.
-- Idempotentna: można uruchomić wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname
  AND TABLE_NAME = 'organization'
  AND COLUMN_NAME = 'invoice_email';

SET @query = IF(@col_exists = 0,
  'ALTER TABLE organization ADD COLUMN invoice_email VARCHAR(100) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE organization SET invoice_email = 'factuur@maizoncozy.eu'
 WHERE ident = 'Cozy' AND (invoice_email IS NULL OR invoice_email = '');
