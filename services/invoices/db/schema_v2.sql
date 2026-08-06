-- =====================================================================
-- Moduł fakturowania — rozszerzenie v2: hierarchia 3 poziomów, odbiorcy
-- końcowi, częściowe fakturowanie, numeracja YYYY/00001 per wystawca.
--
-- Idempotentny (CREATE TABLE IF NOT EXISTS + warunkowe ALTER-y w konwencji
-- `migrations/*.sql`). Uruchamiany razem ze `schema.sql` przez
-- `repository.runSchemaMigration()`.
--
-- ⚠️ JEDEN ALTER DOTYKA ISTNIEJĄCEJ TABELI `order` (kolumna `end_client_id`).
-- Jest to wprost wymagane przez integrację poziomu 3 z formularzem zamówienia.
-- Kolumna jest NULL-owalna, bez FK z ON DELETE CASCADE (usunięcie odbiorcy nie
-- może kasować zamówień) i nie zmienia zachowania istniejących zapytań.
-- =====================================================================

-- ---------------------------------------------------------------------
-- POZIOM 3: odbiorcy końcowi (klienci Użytkownika/salonu).
--
-- ⚠️ To NIE są konta w aplikacji — brak pinu, hasła i logowania. Istnieją
-- wyłącznie jako nabywcy na fakturach i adresaci dostaw, dlatego mają własną
-- tabelę, a nie wiersz w `user` (tam każdy rekord to konto z pinem).
-- Właścicielem rekordu jest Użytkownik (`owner_user_id`) — dane są prywatne
-- dla jego salonu, a organizacja trzymana redundantnie dla filtrów i kontroli
-- dostępu na poziomie tenantów.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_end_client` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `owner_user_id`      INT          NOT NULL,
  `organization_id`    INT          NOT NULL,
  -- 'company' | 'person' — decyduje o wymaganiu NIP-u i o etykiecie na fakturze
  `client_type`        VARCHAR(10)  NOT NULL DEFAULT 'company',
  `name`               VARCHAR(250) NOT NULL,
  `tax_id`             VARCHAR(40)  NULL,
  `vat_eu_id`          VARCHAR(40)  NULL,
  -- Numery rejestrowe zależne od kraju (REGON/KVK/SIREN/SIRET/NAF/Steuernummer)
  `registry_numbers`   JSON         NULL,
  -- Adres rejestrowy (na fakturę)
  `street`             VARCHAR(255) NULL,
  `zip`                VARCHAR(20)  NULL,
  `city`               VARCHAR(255) NULL,
  `country`            VARCHAR(2)   NOT NULL DEFAULT 'PL',
  -- Adres dostawy (może się różnić od rejestrowego)
  `delivery_name`      VARCHAR(250) NULL,
  `delivery_street`    VARCHAR(255) NULL,
  `delivery_zip`       VARCHAR(20)  NULL,
  `delivery_city`      VARCHAR(255) NULL,
  `delivery_country`   VARCHAR(2)   NULL,
  `email`              VARCHAR(160) NULL,
  `phone`              VARCHAR(60)  NULL,
  `default_currency`   CHAR(3)      NOT NULL DEFAULT 'EUR',
  `notes`              TEXT         NULL,
  `is_active`          TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_owner` (`owner_user_id`, `is_active`),
  KEY `idx_owner_name` (`owner_user_id`, `name`),
  KEY `idx_org` (`organization_id`),
  KEY `idx_tax_id` (`tax_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Konfiguracja fakturowania per PODMIOT WYSTAWIAJĄCY i poziom.
--
-- Każdy z 3 poziomów ma własne reguły: waluta, stawki, szablon, wzorzec
-- numeracji, dane rejestrowe, klauzule. `invoice_organization_profile`
-- (z v1) obsługuje poziom 2 — ta tabela generalizuje to na wszystkie poziomy
-- i wszystkich wystawców (producent, organizacja, użytkownik).
--
-- issuer_type: 'manufacturer' | 'organization' | 'user'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_issuer_profile` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `issuer_type`        VARCHAR(20)  NOT NULL,
  -- 0 dla producenta (jeden globalny podmiot), inaczej organization.id / user.id
  `issuer_id`          INT          NOT NULL DEFAULT 0,
  `level`              TINYINT      NOT NULL,
  `name`               VARCHAR(250) NOT NULL,
  `tax_id`             VARCHAR(40)  NULL,
  `vat_eu_id`          VARCHAR(40)  NULL,
  -- {"REGON":"...","KVK":"...","SIREN":"...","SIRET":"...","NAF":"...","STEUERNUMMER":"..."}
  `registry_numbers`   JSON         NULL,
  `street`             VARCHAR(255) NULL,
  `zip`                VARCHAR(20)  NULL,
  `city`               VARCHAR(255) NULL,
  `country`            VARCHAR(2)   NOT NULL DEFAULT 'PL',
  `email`              VARCHAR(160) NULL,
  `phone`              VARCHAR(60)  NULL,
  `bank_name`          VARCHAR(160) NULL,
  `bank_iban`          VARCHAR(42)  NULL,
  `bank_swift`         VARCHAR(15)  NULL,
  `currency`           CHAR(3)      NOT NULL DEFAULT 'EUR',
  `local_currency`     CHAR(3)      NOT NULL DEFAULT 'PLN',
  `payment_days`       INT          NOT NULL DEFAULT 14,
  `default_lang`       VARCHAR(5)   NOT NULL DEFAULT 'pl',
  `template_code`      VARCHAR(60)  NOT NULL DEFAULT 'default',
  `theme_vars`         JSON         NULL,
  -- Wzorzec numeracji; domyślnie uniwersalny format YYYY/00001
  `number_pattern`     VARCHAR(80)  NOT NULL DEFAULT '{YYYY}/{NR:5}',
  -- Krajowe parametry prawne: {"split_payment":true,"late_penalty_rate":"10,5%","vat_exempt_293b":false}
  `legal_settings`     JSON         NULL,
  `footer_notes`       JSON         NULL,
  `created_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_issuer` (`issuer_type`, `issuer_id`, `level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Licznik numeracji per WYSTAWCA i ROK.
--
-- ⚠️ Osobna tabela od `invoice_sequence` (v1, klucz: organizacja+typ+okres),
-- bo tutaj klucz to (wystawca, poziom, rok): każdy podmiot na każdym poziomie
-- ma własną serię `YYYY/00001`, zerowaną 1 stycznia. Inkrementacja jak w v1 —
-- `INSERT … ON DUPLICATE KEY UPDATE LAST_INSERT_ID(last_number + 1)`, czyli
-- atomowo i bez SELECT … FOR UPDATE (patrz `db/repository.js`).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_issuer_sequence` (
  `issuer_type`   VARCHAR(20) NOT NULL,
  `issuer_id`     INT         NOT NULL DEFAULT 0,
  `level`         TINYINT     NOT NULL,
  `year`          SMALLINT    NOT NULL,
  `last_number`   INT         NOT NULL DEFAULT 0,
  `updated_at`    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`issuer_type`, `issuer_id`, `level`, `year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- CZĘŚCIOWE FAKTUROWANIE: alokacje ilości pozycji zamówienia do pozycji faktur.
--
-- Jedna pozycja zamówienia (np. 3 rolety) może zostać zafakturowana partiami
-- (2 szt. + 1 szt.). Każda partia to wiersz tutaj. Suma `invoiced_quantity`
-- dla danego `order_item_id` nie może przekroczyć ilości z zamówienia —
-- pilnuje tego `core/allocations.js` W TRANSAKCJI zapisu faktury
-- (baza nie potrafi tego wyrazić jako CHECK, bo to suma po wielu wierszach).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_item_allocation` (
  `id`                INT AUTO_INCREMENT PRIMARY KEY,
  `invoice_id`        INT           NOT NULL,
  `invoice_item_id`   INT           NOT NULL,
  `order_id`          INT           NOT NULL,
  `order_item_id`     INT           NOT NULL,
  -- Ilość zafakturowana tą partią (DECIMAL, bo pozycje bywają w m²/mb)
  `invoiced_quantity` DECIMAL(12,3) NOT NULL,
  -- Ilość całkowita z zamówienia w chwili alokacji — ślad audytowy, gdyby
  -- zamówienie zostało później skorygowane
  `order_quantity`    DECIMAL(12,3) NOT NULL,
  `created_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_order_item` (`order_item_id`),
  KEY `idx_invoice` (`invoice_id`),
  KEY `idx_invoice_item` (`invoice_item_id`),
  CONSTRAINT `fk_alloc_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alloc_invoice_item` FOREIGN KEY (`invoice_item_id`) REFERENCES `invoice_item` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Rozszerzenia tabeli `invoice`: hierarchia + dane rejestrowe + compliance
-- ---------------------------------------------------------------------
SET @dbname = DATABASE();

-- level: 1 = producent→organizacja, 2 = organizacja→użytkownik, 3 = użytkownik→odbiorca końcowy
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='level';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `level` TINYINT NOT NULL DEFAULT 2 AFTER `organization_id`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='issuer_type';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `issuer_type` VARCHAR(20) NOT NULL DEFAULT ''organization'' AFTER `level`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='issuer_id';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `issuer_id` INT NOT NULL DEFAULT 0 AFTER `issuer_type`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- buyer_type: 'organization' | 'user' | 'end_client' | 'group_user'
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='buyer_type';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `buyer_type` VARCHAR(20) NOT NULL DEFAULT ''user'' AFTER `buyer_group_user_id`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='buyer_end_client_id';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `buyer_end_client_id` INT NULL DEFAULT NULL AFTER `buyer_type`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- Numery rejestrowe skopiowane w chwili wystawienia (jak dane adresowe)
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='seller_registry';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `seller_registry` JSON NULL AFTER `seller_country`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='buyer_registry';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `buyer_registry` JSON NULL AFTER `buyer_country`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- Kontekst prawny wyliczony przy wystawieniu (klauzule, split payment, Leistungsdatum…)
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='compliance';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `compliance` JSON NULL AFTER `legal_notes`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- Data dostawy/usługi — wymagana na fakturze niemieckiej (Leistungsdatum)
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND COLUMN_NAME='delivery_date';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD COLUMN `delivery_date` DATE NULL AFTER `sale_date`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- Indeks pod listowanie per wystawca/poziom
SELECT COUNT(*) INTO @c FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND INDEX_NAME='idx_issuer_level';
SET @q = IF(@c=0, 'ALTER TABLE `invoice` ADD INDEX `idx_issuer_level` (`issuer_type`, `issuer_id`, `level`, `issue_date`)', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------------
-- Rozszerzenia `invoice_item`: odniesienie do zamówienia i wymiary.
-- Wymagane przez specyfikację: pozycja faktury MUSI nieść numer oryginalnego
-- zamówienia, nazwę, wymiary i zafakturowaną partię ilości.
-- ---------------------------------------------------------------------
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice_item' AND COLUMN_NAME='order_number';
SET @q = IF(@c=0, 'ALTER TABLE `invoice_item` ADD COLUMN `order_number` VARCHAR(64) NULL AFTER `order_item_id`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice_item' AND COLUMN_NAME='width_mm';
SET @q = IF(@c=0, 'ALTER TABLE `invoice_item` ADD COLUMN `width_mm` INT NULL AFTER `order_number`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice_item' AND COLUMN_NAME='height_mm';
SET @q = IF(@c=0, 'ALTER TABLE `invoice_item` ADD COLUMN `height_mm` INT NULL AFTER `width_mm`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------------
-- ⚠️ ISTNIEJĄCA TABELA `order`: powiązanie z odbiorcą końcowym (poziom 3).
-- NULL-owalna, bez kaskady — usunięcie odbiorcy nie może ruszyć zamówień.
-- ---------------------------------------------------------------------
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='order' AND COLUMN_NAME='end_client_id';
SET @q = IF(@c=0, 'ALTER TABLE `order` ADD COLUMN `end_client_id` INT NULL DEFAULT NULL AFTER `group_user_id`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='order' AND INDEX_NAME='idx_end_client';
SET @q = IF(@c=0, 'ALTER TABLE `order` ADD INDEX `idx_end_client` (`end_client_id`)', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------------
-- ⚠️ UNIKALNOŚĆ NUMERU: v1 miała `uq_org_number (organization_id, number)`.
-- Po wprowadzeniu hierarchii numeracja jest per (wystawca, poziom, rok), więc
-- ta sama organizacja legalnie ma dwa dokumenty `2026/00001`: jeden wystawiony
-- przez nią (poziom 2), drugi przez jej salon (poziom 3). Stary klucz to
-- blokował („Duplicate entry '3-2026/00001'"), dlatego zamieniamy go na klucz
-- odzwierciedlający właściwy niezmiennik: numer jest unikalny w SERII WYSTAWCY.
-- ---------------------------------------------------------------------
SELECT COUNT(*) INTO @c FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND INDEX_NAME='uq_org_number';
SET @q = IF(@c>0, 'ALTER TABLE `invoice` DROP INDEX `uq_org_number`', 'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SELECT COUNT(*) INTO @c FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='invoice' AND INDEX_NAME='uq_issuer_number';
SET @q = IF(@c=0,
  'ALTER TABLE `invoice` ADD UNIQUE KEY `uq_issuer_number` (`issuer_type`, `issuer_id`, `level`, `number`)',
  'SELECT 1');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
