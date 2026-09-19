-- Migration: add prod_days column to order_item table
-- Szacowany termin produkcji POZYCJI (dni), liczony przez
-- `services/productionDays.js` i zapisywany razem z `order.max_prod_days`.
-- Wartość trafia do JSON-a zamówienia wysyłanego na FTP (`prod_days`).
ALTER TABLE `order_item` ADD COLUMN `prod_days` INT DEFAULT NULL;
