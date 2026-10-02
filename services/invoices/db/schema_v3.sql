-- =====================================================================
-- Moduł fakturowania — v3: formatki (papier firmowy) per organizacja.
--
-- Idempotentny — można puszczać wielokrotnie (information_schema + PREPARE,
-- tak jak schema_v2.sql). Dotyka WYŁĄCZNIE tabeli modułu `invoice_template`.
--
-- background_file — nazwa PDF-a formatki w `img/invoice-background/`
--                   (np. `LUXANGMBH.pdf`); NULL = dokument bez formatki,
-- page_margins    — miejsce na treść na formatce, w mm:
--                   {"top":24,"right":12,"bottom":27,"left":12}
--
-- Przypisanie organizacji: `node scripts/setInvoiceTemplate.js <ORG> --background <plik.pdf>`
-- (wiersz `invoice_template` + `invoice_organization_profile.template_code`).
-- =====================================================================

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice_template' AND COLUMN_NAME='background_file';
SET @q = IF(@c=0, 'ALTER TABLE `invoice_template` ADD COLUMN `background_file` VARCHAR(160) NULL AFTER `stylesheet`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice_template' AND COLUMN_NAME='page_margins';
SET @q = IF(@c=0, 'ALTER TABLE `invoice_template` ADD COLUMN `page_margins` JSON NULL AFTER `background_file`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
