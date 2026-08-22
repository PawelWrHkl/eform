-- Migration: `order.created_by_group_user_id` — KTO założył zamówienie.
--
-- `order.group_user_id` mówi tylko, DO KTÓREGO konta podrzędnego grupy należy
-- zamówienie — a od wprowadzenia kontekstu grupy (services/groupContext.js)
-- taki wiersz może powstać na dwa sposoby: założyć je może samo konto
-- podrzędne (zalogowane jako sklep/klient) albo grupa-matka pracująca „jako
-- ono". Rozróżnienie jest potrzebne, bo dla grupy typu `client`
-- (`user.group_type = 'client'`) zamówienia UTWORZONE PRZEZ KLIENTA są dla
-- grupy tylko do wglądu i zatwierdzenia — nie wolno ich edytować ani usuwać.
-- Bez osobnej kolumny nie da się tego odróżnić i blokada objęłaby także
-- zamówienia, które grupa sama założyła w kontekście klienta.

ALTER TABLE `order`
  ADD COLUMN `created_by_group_user_id` INT DEFAULT NULL;

-- Backfill: kontekst grupy istnieje od 2026-08-21, więc KAŻDE wcześniejsze
-- zamówienie z `group_user_id` mogło powstać wyłącznie z sesji konta
-- podrzędnego — grupa-matka nie miała jak go założyć.
UPDATE `order`
SET `created_by_group_user_id` = `group_user_id`
WHERE `group_user_id` IS NOT NULL
  AND `created_by_group_user_id` IS NULL;

CREATE INDEX `idx_order_created_by_group_user`
  ON `order` (`created_by_group_user_id`);
