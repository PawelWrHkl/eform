-- Migration: moduł „Serwis" (zgłoszenia reklamacyjne i serwisowe) — services/serviceTickets.
-- Cztery tabele: zgłoszenie, pozycje zgłoszenia, pliki (zdjęcia), oś czasu (wzorzec `invoice_event`).
--
-- Klucze obce TYLKO wewnątrz modułu (item/file/event → ticket, CASCADE) i do `department`
-- (SET NULL; groupSync tylko upsertuje). Celowo BEZ kluczy do `user`, `order`, `order_item`,
-- `employee`, `group_user` — jak `order.user_id` i audyt biura: zgłoszenie ma przetrwać usunięcie
-- konta przez dbUserSync (contractors.txt), a zamiatarka demo (services/demoMode.js) nie może się
-- wywrócić na `DELETE FROM order_item` — zgłoszenia konta demo kasuje ona sama, przed zleceniami.
-- Migawka właściciela (user_ident, client_name, organization_ident, created_by) zastępuje te klucze.
--
-- Numer zgłoszenia `SRV-<rok>-<id na 5 cyfr>` liczony z AUTO_INCREMENT w tej samej transakcji
-- co INSERT (UPDATE po id) — bez osobnego licznika.
-- Idempotentna — można uruchamiać wielokrotnie.

CREATE TABLE IF NOT EXISTS `service_ticket` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `number`             VARCHAR(20)  NULL,                 -- SRV-2026-00042 (UNIQUE; NULL tylko między INSERT a UPDATE w transakcji)
  `type`               VARCHAR(20)  NOT NULL,             -- repair | complaint | transport | delivery (services/serviceTickets/rules.js)
  `status`             VARCHAR(30)  NOT NULL DEFAULT 'submitted',
  `order_id`           INT          NULL,                 -- zlecenie eForm (`order.id`) albo NULL = „nie mam numeru zlecenia"
  `order_no_text`      VARCHAR(100) NULL,                 -- numer wpisany ręcznie przy zgłoszeniu bez zlecenia
  `commission`         VARCHAR(255) NOT NULL,
  `department_id`      INT          NULL,                 -- kolekcja wybrana ręcznie (zgłoszenie bez zlecenia)
  `category`           VARCHAR(40)  NULL,                 -- rodzaj 4 (zapytanie o dostawę): jedna kategoria na zgłoszenie
  `description`        TEXT         NULL,
  `description_pl`     TEXT         NULL,                 -- tłumaczenie na polski dla HKL (commentTranslator)
  `contact_name`       VARCHAR(150) NOT NULL,
  `contact_phone`      VARCHAR(50)  NOT NULL,
  `contact_email`      VARCHAR(160) NOT NULL,
  `product_address`    VARCHAR(500) NULL,
  `end_client`         VARCHAR(250) NULL,
  `delivered_at`       DATE         NULL,                 -- transport: data dostawy
  `carrier_noted`      TINYINT(1)   NULL,                 -- transport: uszkodzenie odnotowane u kuriera
  `quote_before_repair` TINYINT(1)  NULL,                 -- naprawa: wycena przed naprawą poza gwarancją
  `lang`               CHAR(2)      NULL,                 -- język klienta (maile o zmianie statusu)
  -- migawka właściciela zgłoszenia
  `user_id`            INT          NULL,
  `user_ident`         VARCHAR(50)  NULL,
  `client_name`        VARCHAR(128) NULL,
  `organization_id`    INT          NULL,
  `organization_ident` VARCHAR(70)  NULL,
  `group_user_id`      INT          NULL,
  `employee_id`        INT          NULL,
  `created_by`         VARCHAR(100) NOT NULL,             -- user:<ident> | employee:<id> | admin:<ident> -> <klient> | staff:<ident> -> <klient>
  `hkl_ref`            VARCHAR(100) NULL,                 -- numer w bazie reklamacji HKL, gdy wróci
  `created_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `closed_at`          DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_service_ticket_number` (`number`),
  KEY `idx_service_ticket_user` (`user_id`),
  KEY `idx_service_ticket_order` (`order_id`),
  KEY `idx_service_ticket_status` (`status`),
  KEY `idx_service_ticket_created` (`created_at`),
  CONSTRAINT `fk_service_ticket_department` FOREIGN KEY (`department_id`) REFERENCES `department` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `service_ticket_event` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `ticket_id`  INT          NOT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actor`      VARCHAR(100) NOT NULL,                     -- jak `created_by`; `system` dla eksportu/maili
  `kind`       VARCHAR(30)  NOT NULL,                     -- created | client_message | status | export_ok | export_failed | mail_sent | mail_failed
  `status`     VARCHAR(30)  NULL,                         -- nowy status przy kind = status
  `message`    TEXT         NULL,                         -- treść dopisku / wiadomość do klienta / błąd eksportu
  PRIMARY KEY (`id`),
  KEY `idx_service_ticket_event_ticket` (`ticket_id`, `created_at`),
  KEY `idx_service_ticket_event_kind` (`kind`),
  CONSTRAINT `fk_service_ticket_event_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `service_ticket` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `service_ticket_item` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `ticket_id`     INT          NOT NULL,
  `order_item_id` INT          NULL,                      -- `order_item.id` (bez klucza — patrz nagłówek)
  `order_pos`     VARCHAR(32)  NULL,                      -- numer pozycji, także podpozycja `1-1`
  `department_id` INT          NULL,                      -- kolekcja wyliczona z product_group.department_id
  `qty`           INT          NOT NULL DEFAULT 1,        -- ilość, której dotyczy zgłoszenie (≤ ILOSC pozycji)
  `category`      VARCHAR(40)  NOT NULL,
  `note`          VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_service_ticket_item_ticket` (`ticket_id`),
  KEY `idx_service_ticket_item_order_item` (`order_item_id`),
  CONSTRAINT `fk_service_ticket_item_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `service_ticket` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_service_ticket_item_department` FOREIGN KEY (`department_id`) REFERENCES `department` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `service_ticket_file` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `ticket_id`     INT          NOT NULL,
  `event_id`      INT          NULL,                      -- plik dopisku klienta; NULL = plik ze zgłoszenia
  `stored_name`   VARCHAR(120) NOT NULL,                  -- nazwa na dysku nadana przez serwer (outputData/service/<numer>/)
  `original_name` VARCHAR(255) NOT NULL,                  -- tylko metadana
  `mime`          VARCHAR(80)  NOT NULL,                  -- z zawartości pliku (magic bytes), nie z przeglądarki
  `size`          INT UNSIGNED NOT NULL,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_service_ticket_file_ticket` (`ticket_id`),
  KEY `idx_service_ticket_file_event` (`event_id`),
  CONSTRAINT `fk_service_ticket_file_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `service_ticket` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_service_ticket_file_event` FOREIGN KEY (`event_id`) REFERENCES `service_ticket_event` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
