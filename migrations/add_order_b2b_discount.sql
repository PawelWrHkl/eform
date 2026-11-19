-- Migration: rabat B2B, który organizacja (owner) daje swojemu klientowi w ofercie.
--   order.b2b_discount_points     — punkty procentowe doliczane do rabatu z cennika
--                                   (`SUB___CENA_RABAT`) każdej pozycji: 70% + 3 = 73%;
--   order.b2b_discount_amount     — rabat kwotowy wpisany przez ownera (waluta zlecenia),
--                                   tylko do pokazania w oknie;
--   order.b2b_discount_amount_pct — ta kwota zamieniona przy zapisie na równy procent
--                                   wartości zlecenia po rabacie % (z niej liczy przeglądarka).
-- Tabela order_b2b_discount_log — historia zmian (kto, kiedy, wartości przed i po).
-- Liczenie: public/scripts/formTools/pricesCalculator.js applyClientDiscount,
-- źródło: services/b2bDiscount.js. Idempotentna — można uruchamiać wielokrotnie.

SET @dbname = DATABASE();

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND COLUMN_NAME = 'b2b_discount_points';
SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN b2b_discount_points DECIMAL(5,2) NOT NULL DEFAULT 0.00',
  'SELECT 1');
PREPARE stmt FROM @query; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND COLUMN_NAME = 'b2b_discount_amount';
SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN b2b_discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER b2b_discount_points',
  'SELECT 1');
PREPARE stmt FROM @query; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND COLUMN_NAME = 'b2b_discount_amount_pct';
SET @query = IF(@col_exists = 0,
  'ALTER TABLE `order` ADD COLUMN b2b_discount_amount_pct DECIMAL(9,6) NOT NULL DEFAULT 0.000000 AFTER b2b_discount_amount',
  'SELECT 1');
PREPARE stmt FROM @query; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `order_b2b_discount_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NOT NULL,
  `changed_by_user_id` INT NULL,
  `old_points` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `old_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `old_amount_pct` DECIMAL(9,6) NOT NULL DEFAULT 0.000000,
  `new_points` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `new_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `new_amount_pct` DECIMAL(9,6) NOT NULL DEFAULT 0.000000,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_ob2b_order` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
