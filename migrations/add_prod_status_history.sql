-- Migration: historia postępu produkcji (STATUSPROD ze status.txt) — 2026-11-13
--
-- Każdy STATUSPROD zaobserwowany dla pozycji zlecenia zapisuje się RAZ
-- (INSERT IGNORE na unikalnym kluczu). Statusy potrafią się cofać, a przyciski
-- „Korekta” i „Anuluj” mają zniknąć na stałe, gdy choć raz pozycja miała ≥ 20%
-- albo status bez procentu (services/prodProgress.js).
-- `prod_percent` NULL = status bez % („Got.do fakt.”, „Zafakturowane”, „Anulacja”) → blokuje.
-- Idempotentna: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS prod_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_ident VARCHAR(100) NOT NULL,
  user_ident VARCHAR(100) NOT NULL,
  order_idx VARCHAR(50) NOT NULL,
  order_pos VARCHAR(50) NOT NULL,
  status_prod VARCHAR(100) NOT NULL,
  prod_percent DECIMAL(5,2) NULL,
  first_seen_at DATETIME NOT NULL,
  UNIQUE KEY uq_prod_status_history (org_ident, user_ident, order_idx, order_pos, status_prod),
  KEY idx_prod_status_history_order (org_ident, user_ident, order_idx)
);
