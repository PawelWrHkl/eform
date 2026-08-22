-- Migration: `group_user.discount_percent` — rabat, który grupa typu `client`
-- (`user.group_type = 'client'`) nadaje swojemu klientowi.
--
-- Rabat jest procentem od ceny klienta wyliczonej przez silnik i doliczanym
-- dopiero PO przeliczeniu pozycji (patrz public/scripts/formTools/pricesCalculator.js
-- → applyClientDiscount). Nie jest tym samym co rabaty z `prod.txt`
-- (`param-CENA_RABAT-<wariant>.js`), które są wyborem wariantu pliku po stronie
-- organizacji — ten tutaj należy do grupy i dotyczy pojedynczego konta
-- podrzędnego.
--
-- ⚠️ Kolumna istnieje dla WSZYSTKICH kont podrzędnych, ale interfejs pozwala ją
-- ustawić tylko grupom typu `client`; dla `shop` zostaje 0 i nic nie zmienia.

ALTER TABLE `group_user`
  ADD COLUMN `discount_percent` DECIMAL(5,2) NOT NULL DEFAULT 0.00;
