-- =====================================================================
-- Moduł fakturowania — schemat MySQL (baza `eform`)
--
-- Konwencja repo: migracje idempotentne, uruchamiane ręcznie
-- (`mysql eform < services/invoices/db/schema.sql`). Skrypt można puścić
-- wielokrotnie — używa CREATE TABLE IF NOT EXISTS i nie modyfikuje
-- istniejących tabel zamówień.
--
-- DECYZJE PROJEKTOWE:
--  * Kwoty jako DECIMAL(12,2) — nie FLOAT. Obliczenia idą w groszach w Node
--    (`core/money.js`), baza przechowuje wynik w jednostkach głównych.
--  * Dane sprzedawcy i nabywcy są ZDENORMALIZOWANE (skopiowane w chwili
--    wystawienia). Zmiana adresu klienta nie może zmienić treści dokumentu
--    wystawionego wcześniej — dlatego nie ma tu FK na `user`/`organization`
--    dla danych adresowych, jest tylko `buyer_user_id` jako ślad powiązania.
--  * Podsumowanie VAT trzymamy w osobnej tabeli (`invoice_tax_line`), a nie
--    liczymy w locie: stawki i reguły zmieniają się w czasie, a dokument musi
--    zostać taki, jaki został wystawiony.
--  * Numeracja: `invoice_sequence` z kluczem (organizacja, typ, okres) i
--    atomową inkrementacją — patrz `db/repository.js:allocateSequence`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profil fakturowania organizacji (multi-tenancy)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_organization_profile` (
  `organization_id`      INT NOT NULL,
  -- Dane sprzedawcy nadpisujące `organization.*` na dokumentach (opcjonalne).
  `seller_name`          VARCHAR(250) NULL,
  `seller_tax_id`        VARCHAR(40)  NULL,
  `seller_vat_eu_id`     VARCHAR(40)  NULL,
  `seller_street`        VARCHAR(255) NULL,
  `seller_zip`           VARCHAR(20)  NULL,
  `seller_city`          VARCHAR(255) NULL,
  `seller_country`       VARCHAR(2)   NULL,
  `seller_email`         VARCHAR(120) NULL,
  `seller_phone`         VARCHAR(60)  NULL,
  -- Dane bankowe drukowane w sekcji płatności
  `bank_name`            VARCHAR(160) NULL,
  `bank_iban`            VARCHAR(42)  NULL,
  `bank_swift`           VARCHAR(15)  NULL,
  -- Domyślne parametry dokumentów
  `local_currency`       CHAR(3)      NOT NULL DEFAULT 'PLN',
  `default_currency`     CHAR(3)      NOT NULL DEFAULT 'EUR',
  `default_payment_days` INT          NOT NULL DEFAULT 14,
  `default_lang`         VARCHAR(5)   NOT NULL DEFAULT 'pl',
  `default_payment_method` VARCHAR(20) NOT NULL DEFAULT 'transfer',
  -- Szablon i motyw (patrz `render/renderer.js` oraz `templates/`)
  `template_code`        VARCHAR(60)  NOT NULL DEFAULT 'default',
  -- Zmienne CSS motywu: {"accent":"#1f2937","font":"Arial, sans-serif"}
  `theme_vars`           JSON         NULL,
  -- Wzorce numeracji per typ dokumentu:
  -- {"invoice":"FV/{YYYY}/{MM}/{NR}","advance":"ZAL/{YYYY}/{MM}/{NR}"}
  `number_patterns`      JSON         NULL,
  -- Stopka: klauzule KRS/CEIDG/RODO, per język: {"pl":"…","de":"…"}
  `footer_notes`         JSON         NULL,
  `created_at`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`organization_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Szablony dokumentów. Organizacja wskazuje szablon przez `template_code`;
-- wiele organizacji może współdzielić jeden szablon z różnymi `theme_vars`.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_template` (
  `code`          VARCHAR(60)  NOT NULL,
  `name`          VARCHAR(160) NOT NULL,
  -- Ścieżka względem `services/invoices/templates/`
  `template_file` VARCHAR(160) NOT NULL DEFAULT 'invoice-main.njk',
  `stylesheet`    VARCHAR(160) NOT NULL DEFAULT 'styles/invoice.css',
  -- Domyślne zmienne motywu, nadpisywalne przez profil organizacji
  `theme_vars`    JSON         NULL,
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `invoice_template` (`code`, `name`, `template_file`, `stylesheet`)
SELECT 'default', 'Szablon domyślny', 'invoice-main.njk', 'styles/invoice.css'
WHERE NOT EXISTS (SELECT 1 FROM `invoice_template` WHERE `code` = 'default');

-- ---------------------------------------------------------------------
-- Stawki podatku — tabela pomocnicza/audytowa. Runtime bierze stawki z
-- `services/vatCalculator.js`; ta tabela pozwala organizacji nadpisać stawkę
-- (np. stawka obniżona na montaż) bez zmiany kodu.
-- PUNKT ROZSZERZENIA: `valid_from`/`valid_to` umożliwia wersjonowanie stawek.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_tax_rate` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `organization_id` INT           NULL,      -- NULL = stawka globalna
  `country`         VARCHAR(2)    NOT NULL,
  `tax_category`    VARCHAR(30)   NOT NULL,  -- standard|reduced|intra_eu_goods|…
  `rate`            DECIMAL(5,2)  NOT NULL,
  `valid_from`      DATE          NOT NULL DEFAULT '2000-01-01',
  `valid_to`        DATE          NULL,
  `note`            VARCHAR(255)  NULL,
  UNIQUE KEY `uq_rate` (`organization_id`, `country`, `tax_category`, `valid_from`),
  KEY `idx_lookup` (`country`, `tax_category`, `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Licznik numeracji. Jeden wiersz na (organizacja, typ dokumentu, okres).
-- Okres wynika ze wzorca: '2026-08' (miesięczny), '2026' (roczny), 'all' (ciągły).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_sequence` (
  `organization_id` INT         NOT NULL,
  `document_type`   VARCHAR(20) NOT NULL,
  `period_key`      VARCHAR(12) NOT NULL,
  `last_number`     INT         NOT NULL DEFAULT 0,
  `updated_at`      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`organization_id`, `document_type`, `period_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Faktura (nagłówek)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,
  `organization_id`       INT          NOT NULL,
  `document_type`         VARCHAR(20)  NOT NULL,
  `status`                VARCHAR(20)  NOT NULL DEFAULT 'draft',
  -- NULL dopóki dokument jest szkicem — numer nadajemy przy wystawieniu
  `number`                VARCHAR(64)  NULL,
  `issue_date`            DATE         NOT NULL,
  `sale_date`             DATE         NOT NULL,
  `due_date`              DATE         NOT NULL,
  `currency`              CHAR(3)      NOT NULL DEFAULT 'EUR',
  `local_currency`        CHAR(3)      NOT NULL DEFAULT 'PLN',
  `exchange_rate`         DECIMAL(12,6) NULL,
  `exchange_rate_date`    DATE         NULL,
  `exchange_rate_source`  VARCHAR(60)  NULL,
  -- Sprzedawca (kopia)
  `seller_name`           VARCHAR(250) NOT NULL,
  `seller_tax_id`         VARCHAR(40)  NULL,
  `seller_vat_eu_id`      VARCHAR(40)  NULL,
  `seller_street`         VARCHAR(255) NULL,
  `seller_zip`            VARCHAR(20)  NULL,
  `seller_city`           VARCHAR(255) NULL,
  `seller_country`        VARCHAR(2)   NULL,
  -- Nabywca (kopia)
  `buyer_user_id`         INT          NULL,
  `buyer_group_user_id`   INT          NULL,
  `buyer_name`            VARCHAR(250) NOT NULL,
  `buyer_tax_id`          VARCHAR(40)  NULL,
  `buyer_vat_eu_id`       VARCHAR(40)  NULL,
  `buyer_vat_eu_verified` TINYINT(1)   NOT NULL DEFAULT 0,
  `buyer_street`          VARCHAR(255) NULL,
  `buyer_zip`             VARCHAR(20)  NULL,
  `buyer_city`            VARCHAR(255) NULL,
  `buyer_country`         VARCHAR(2)   NULL,
  `buyer_email`           VARCHAR(120) NULL,
  -- Kwoty (waluta dokumentu)
  `total_net`             DECIMAL(12,2) NOT NULL DEFAULT 0,
  `total_tax`             DECIMAL(12,2) NOT NULL DEFAULT 0,
  `total_gross`           DECIMAL(12,2) NOT NULL DEFAULT 0,
  `total_tax_local`       DECIMAL(12,2) NULL,   -- VAT w walucie lokalnej sprzedawcy
  `advance_settled`       DECIMAL(12,2) NOT NULL DEFAULT 0,
  `amount_due`            DECIMAL(12,2) NOT NULL DEFAULT 0,
  `paid_amount`           DECIMAL(12,2) NOT NULL DEFAULT 0,
  `paid_at`               DATETIME     NULL,
  `payment_method`        VARCHAR(20)  NULL,
  -- Powiązania
  `order_id`              INT          NULL,
  `parent_invoice_id`     INT          NULL,   -- zaliczka → faktura końcowa
  `corrected_invoice_id`  INT          NULL,   -- korekta → dokument korygowany
  `correction_reason`     VARCHAR(500) NULL,
  -- Prezentacja
  `lang`                  VARCHAR(5)   NOT NULL DEFAULT 'pl',
  `template_code`         VARCHAR(60)  NOT NULL DEFAULT 'default',
  `notes`                 TEXT         NULL,
  `legal_notes`           JSON         NULL,    -- klucze i18n adnotacji (reverse charge itd.)
  `created_by_pin`        VARCHAR(12)  NULL,
  `created_at`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Numer musi być unikalny w obrębie organizacji (NULL-e się nie kolidują)
  UNIQUE KEY `uq_org_number` (`organization_id`, `number`),
  KEY `idx_org_status` (`organization_id`, `status`),
  KEY `idx_order` (`order_id`),
  KEY `idx_buyer` (`buyer_user_id`),
  KEY `idx_issue_date` (`issue_date`),
  CONSTRAINT `fk_invoice_corrected` FOREIGN KEY (`corrected_invoice_id`) REFERENCES `invoice` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_invoice_parent` FOREIGN KEY (`parent_invoice_id`) REFERENCES `invoice` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Pozycje faktury
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_item` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `invoice_id`      INT           NOT NULL,
  `position`        INT           NOT NULL,
  `name`            VARCHAR(500)  NOT NULL,
  `description`     VARCHAR(1000) NULL,
  `unit`            VARCHAR(10)   NOT NULL DEFAULT 'szt',
  `quantity`        DECIMAL(12,3) NOT NULL DEFAULT 1,
  `unit_price_net`  DECIMAL(12,2) NOT NULL DEFAULT 0,
  `discount_percent` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `net_amount`      DECIMAL(12,2) NOT NULL DEFAULT 0,
  `tax_category`    VARCHAR(30)   NOT NULL DEFAULT 'standard',
  `tax_rate`        DECIMAL(5,2)  NOT NULL DEFAULT 0,
  `tax_amount`      DECIMAL(12,2) NOT NULL DEFAULT 0,
  `gross_amount`    DECIMAL(12,2) NOT NULL DEFAULT 0,
  `order_item_id`   INT           NULL,
  -- Dane źródłowe pozycji (wymiary, powierzchnia, grupa asortymentowa) —
  -- do wydruku ilości w m²/mb i do audytu skąd wzięła się kwota
  `meta`            JSON          NULL,
  KEY `idx_invoice` (`invoice_id`),
  KEY `idx_order_item` (`order_item_id`),
  CONSTRAINT `fk_item_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Podsumowanie VAT — jeden wiersz na parę (stawka, kategoria).
-- Zapisywane, nie liczone w locie: dokument musi zostać niezmienny.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_tax_line` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `invoice_id`     INT           NOT NULL,
  `tax_category`   VARCHAR(30)   NOT NULL,
  `tax_rate`       DECIMAL(5,2)  NOT NULL,
  `net_amount`     DECIMAL(12,2) NOT NULL DEFAULT 0,
  `tax_amount`     DECIMAL(12,2) NOT NULL DEFAULT 0,
  `gross_amount`   DECIMAL(12,2) NOT NULL DEFAULT 0,
  `legal_note_key` VARCHAR(60)   NULL,
  KEY `idx_invoice` (`invoice_id`),
  CONSTRAINT `fk_taxline_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Log zdarzeń dokumentu (audyt: kto wystawił, kto oznaczył jako zapłacone).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_event` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `invoice_id`  INT          NOT NULL,
  `event_type`  VARCHAR(40)  NOT NULL,   -- created|issued|status_changed|pdf_generated|sent
  `from_status` VARCHAR(20)  NULL,
  `to_status`   VARCHAR(20)  NULL,
  `actor_pin`   VARCHAR(12)  NULL,
  `payload`     JSON         NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_invoice` (`invoice_id`),
  CONSTRAINT `fk_event_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Kolumny wyniku weryfikacji VIES (dodawane idempotentnie — tabela `invoice`
-- mogła zostać utworzona wcześniejszą wersją schematu).
-- Konwencja z `migrations/*.sql`: sprawdzenie w information_schema + PREPARE.
-- ---------------------------------------------------------------------
SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'vies_checked_at';
SET @q = IF(@col_exists = 0,
  'ALTER TABLE `invoice` ADD COLUMN `vies_checked_at` DATETIME NULL DEFAULT NULL AFTER `buyer_vat_eu_verified`',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'vies_valid';
SET @q = IF(@col_exists = 0,
  'ALTER TABLE `invoice` ADD COLUMN `vies_valid` TINYINT(1) NULL DEFAULT NULL AFTER `vies_checked_at`',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
