-- Migration: moduł „Klienci organizacji" (/org/customers)
--
-- Dodaje:
--   1. `customer_commercial_terms` — warunki handlowe klienta (1:1 z `user`),
--   2. `customer_export_log`       — audyt eksportu klienta do systemu zewnętrznego,
--   3. `employee.can_manage_customers` — uprawnienie pracownika (jak `can_send_orders`),
--   4. indeks na `user.ident` — moduł sprawdza unikalność identyfikatora przy każdym zapisie.
--
-- ⚠️ `user.ident` NIE dostaje UNIQUE: w bazie już siedzą duplikaty (np. 'MäX' x2),
-- więc unikalny indeks wywróciłby migrację. Unikalność pilnuje warstwa serwisu
-- (`services/orgCustomers/index.js` → `assertIdentFree`). Założenie UNIQUE jest
-- follow-upem po jednorazowym czyszczeniu duplikatów.
--
-- Idempotentna: MySQL 9.x nie zna `ADD COLUMN IF NOT EXISTS`, więc kolumna i
-- indeks idą przez procedurę czytającą `information_schema`.

CREATE TABLE IF NOT EXISTS `customer_commercial_terms` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `organization_id` INT NOT NULL,

  -- Cennik i rabaty
  `price_list_code` VARCHAR(50) DEFAULT NULL,
  `price_list_version` VARCHAR(30) DEFAULT NULL,
  `discount_global_pct` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  -- [{ product_group, discount_pct, valid_from, valid_to }, …]
  `discount_rules` JSON DEFAULT NULL,
  `surcharge_version` VARCHAR(30) DEFAULT NULL,
  `sub_price_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  -- Mnożnik WYŁĄCZNIE wizualny — ta sama semantyka co `employee.price_factor`.
  `price_factor` DECIMAL(6,4) NOT NULL DEFAULT 1.0000,
  `currency` CHAR(3) NOT NULL DEFAULT 'EUR',
  `vat_rate` DECIMAL(5,2) DEFAULT NULL,
  `payment_terms_days` INT NOT NULL DEFAULT 0,
  `credit_limit` DECIMAL(12,2) DEFAULT NULL,

  -- Komunikacja
  `locale` VARCHAR(5) DEFAULT NULL,
  `preferred_channel` ENUM('email','phone') NOT NULL DEFAULT 'email',

  -- RODO
  `rodo_consent` TINYINT(1) NOT NULL DEFAULT 0,
  `rodo_consent_at` DATETIME DEFAULT NULL,
  `terms_version` VARCHAR(30) DEFAULT NULL,

  -- Meta
  `notes` TEXT DEFAULT NULL,
  `tags` JSON DEFAULT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `deactivated_at` DATETIME DEFAULT NULL,
  `created_by_user_id` INT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY `uniq_cct_user` (`user_id`),
  KEY `idx_cct_org` (`organization_id`),
  KEY `idx_cct_active` (`organization_id`, `active`),
  CONSTRAINT `fk_cct_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_export_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `attempt_no` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- 'create' | 'update' | 'manual'
  `trigger_source` VARCHAR(20) NOT NULL DEFAULT 'create',
  `status` ENUM('success','error','skipped') NOT NULL,
  `http_code` SMALLINT UNSIGNED DEFAULT NULL,
  -- ⚠️ Logujemy WYŁĄCZNIE hash payloadu — payload niesie dane osobowe i warunki
  -- handlowe, nie ma czego trzymać w logu.
  `payload_hash` CHAR(64) NOT NULL,
  `idempotency_key` CHAR(64) DEFAULT NULL,
  `response_body` TEXT DEFAULT NULL,
  `error` TEXT DEFAULT NULL,
  `duration_ms` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY `idx_cel_user` (`user_id`),
  KEY `idx_cel_created` (`created_at`),
  KEY `idx_cel_status` (`status`),
  CONSTRAINT `fk_cel_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS `eform_add_org_customers_bits`;
DELIMITER //
CREATE PROCEDURE `eform_add_org_customers_bits`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'employee' AND column_name = 'can_manage_customers'
  ) THEN
    ALTER TABLE `employee`
      ADD COLUMN `can_manage_customers` TINYINT(1) NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'user' AND index_name = 'idx_user_ident'
  ) THEN
    ALTER TABLE `user` ADD INDEX `idx_user_ident` (`ident`);
  END IF;
END//
DELIMITER ;

CALL `eform_add_org_customers_bits`();
DROP PROCEDURE `eform_add_org_customers_bits`;
