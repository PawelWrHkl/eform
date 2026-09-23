-- Migration: `user.extra_rabat` — dodatkowy rabat klienta (w punktach
-- procentowych), doliczany do rabatu cennikowego przez
-- `services/portalUsageDiscount.js`.
--
-- Zastępuje dotychczasową regułę wyliczaną z danych (organizacja LUXANGMBH
-- `organization.id = 5` + brak zamówień utworzonych przed 2026-09-09 → stałe
-- 1%). Od teraz JEDYNYM źródłem informacji „czy i ile" jest ta kolumna:
-- rabat dostaje każdy klient z wartością > 0, niezależnie od organizacji
-- i historii zamówień, w wysokości tu wpisanej.
--
-- Jednostka to PUNKT PROCENTOWY, nie ułamek: `1.00` = 1% (dotychczasowe
-- zachowanie), `2.50` = 2,5%. Wartość dolicza się do rabatu cennikowego
-- (60% + 1% = 61% liczone od ceny katalogowej) — patrz wpis z 2026-09-11
-- w PROJECT_OVERVIEW.md.
--
-- ⚠️ Kolumna startuje PUSTA (0.00) dla WSZYSTKICH kont — decyzja właściciela.
-- Klienci, którzy dostawali 1% ze starej reguły, tracą go z chwilą wdrożenia
-- i odzyskają dopiero po ręcznym wpisaniu wartości.
--
-- ⚠️ Rabat nadal gasi przełącznik admina (`<dataDir>/.portal-usage-discount.json`,
-- `services/portalUsageDiscountSwitch.js`) — wyłączony przełącznik zeruje rabat
-- wszystkim, niezależnie od zawartości tej kolumny.

ALTER TABLE `user`
  ADD COLUMN `extra_rabat` DECIMAL(5,2) NOT NULL DEFAULT 0.00;
