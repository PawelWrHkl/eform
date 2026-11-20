-- Termin 60 dni na fakturach HKL → Cozy i HKL → Luxan GmbH (poziom 1), jak na fakturach PROD
-- z 16–17.11.2026 (pytanie Wiktorii z 20.11, decyzja Pawła „jedno i drugie”).
--
-- Termin organizacji-nabywcy leży na jej koncie z contractors.txt (`user.payment_days`, ident konta =
-- ident organizacji: Cozy, LuxanGmbH) — NIE w `invoice_organization_profile.default_payment_days`, bo
-- tamto pole to termin, który organizacja daje SWOIM klientom (faktury Cozy → klient), i edytuje je owner.
--
-- Uruchamiać PO `migrations/add_user_payment_days.sql`; bez kolumny nic nie robi.
-- Idempotentne. Gdy contractors.txt dostanie kolumnę PAYMENT_DAYS, wartość z pliku zastąpi tę
-- (puste/„-” u Cozy albo LuxanGmbH = powrót do 14 dni z profilu HKL).

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @c1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND COLUMN_NAME = 'payment_days';
SET @q = IF(@c1 = 1,
  'UPDATE `user` u JOIN organization o ON o.ident = u.ident SET u.payment_days = 60 WHERE o.ident IN (''Cozy'', ''LUXANGMBH'')',
  'SELECT ''brak kolumny user.payment_days — najpierw migrations/add_user_payment_days.sql'' AS uwaga');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT o.id AS organization_id, o.ident AS organizacja, u.id AS user_id, u.ident AS konto
  FROM organization o LEFT JOIN `user` u ON u.ident = o.ident
 WHERE o.ident IN ('Cozy', 'LUXANGMBH');
