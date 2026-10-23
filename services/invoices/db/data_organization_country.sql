-- Kraje organizacji (`organization.country`) — bez nich moduł faktur nie ustali VAT:
-- krajowy (PL 23%, DE 19%, NL 21%) / WDT 0% / eksport (`core/taxRules.js`).
--
-- 2026-10-22: na produkcji wszystkie organizacje miały NULL, więc pierwszy przebieg
-- automatu wystawił 94 faktury z 0% „np” (także krajowe PL→PL i DE→DE). Baza testowa
-- miała te wartości wpisane ręcznie — tu są te same, 1:1. Od tego dnia faktura bez
-- kraju sprzedawcy albo nabywcy jest blokowana (`main.js`, INVOICE_COUNTRY_MISSING).
--
-- Kraj = prefiks numeru VAT organizacji (`tax_id`). Idempotentne: zmienia wyłącznie
-- puste pole i tylko wtedy, gdy id, ident i prefiks numeru się zgadzają — na innej
-- bazie (inne id/ident) nic nie robi. Nowa organizacja: wpisz kraj przy zakładaniu.

UPDATE organization SET country = 'NL' WHERE id = 1 AND ident = 'Cozy'               AND (country IS NULL OR TRIM(country) = '') AND REPLACE(tax_id, ' ', '') LIKE 'NL%';
UPDATE organization SET country = 'DE' WHERE id = 2 AND ident = 'FENIX'              AND (country IS NULL OR TRIM(country) = '') AND REPLACE(tax_id, ' ', '') LIKE 'DE%';
UPDATE organization SET country = 'PL' WHERE id = 3 AND ident = 'HKL'                AND (country IS NULL OR TRIM(country) = '') AND REPLACE(tax_id, ' ', '') LIKE 'PL%';
UPDATE organization SET country = 'PL' WHERE id = 4 AND ident = 'LUXAN_EWA_KRAWCZYK' AND (country IS NULL OR TRIM(country) = '') AND REPLACE(tax_id, ' ', '') LIKE 'PL%';
UPDATE organization SET country = 'DE' WHERE id = 5 AND ident = 'LUXANGMBH'          AND (country IS NULL OR TRIM(country) = '') AND REPLACE(tax_id, ' ', '') LIKE 'DE%';
UPDATE organization SET country = 'DE' WHERE id = 7 AND ident = 'REMASUN'            AND (country IS NULL OR TRIM(country) = '') AND REPLACE(tax_id, ' ', '') LIKE 'DE%';
