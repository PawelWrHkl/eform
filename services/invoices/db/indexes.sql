-- =====================================================================
-- Indeksy pod wyszukiwanie w panelu faktur — DOTYKAJĄ ISTNIEJĄCYCH TABEL
-- (`user`, `order`), dlatego są w osobnym pliku i NIE są uruchamiane przez
-- `repository.runSchemaMigration()`. Uruchom świadomie:
--
--   mysql -h "$DATABASE_HOST" -P "$DATABASE_PORT" -u "$DATABASE_USER" -p eform \
--     < services/invoices/db/indexes.sql
--
-- DLACZEGO: comboboxy panelu pytają `/api/v1/invoices/search/{clients,orders}`.
-- Zapytania filtrują po organizacji i szukają po nazwie (`LIKE 'q%'` oraz
-- `LIKE '%q%'`). Stan indeksów PRZED tą migracją (sprawdzone `SHOW INDEX`):
--   `user`  → PRIMARY(id), pin(pin), fk_user_organization(organization_id)
--   `order` → PRIMARY(id), user_id(user_id), + FK na adresy/pracownika
-- Czyli: filtr po organizacji i po kliencie ma indeks, ale sortowanie i
-- dopasowanie nazwy już nie. Przy 1931 klientach / 1860 zamówieniach zapytania
-- schodzą w 0,8–1,8 ms i indeksy nie są potrzebne — mają znaczenie dopiero przy
-- dziesiątkach tysięcy wierszy.
--
-- ⚠️ OGRANICZENIE, którego indeks NIE naprawi: `LIKE '%fragment%'` nigdy nie
-- skorzysta z indeksu B-drzewa (wiodący `%`). Indeksy poniżej przyspieszają
-- dopasowanie po PREFIKSIE i sortowanie; wyszukiwanie po fragmencie w środku
-- nazwy zostaje skanem w obrębie organizacji. Gdyby to zaczęło doskwierać,
-- właściwym krokiem jest indeks pełnotekstowy:
--   ALTER TABLE `user` ADD FULLTEXT KEY `ft_client_name` (`client_name`);
--   -- i zapytanie MATCH … AGAINST (… IN BOOLEAN MODE) z sufiksem `*`
-- (FULLTEXT ma własne pułapki: minimalna długość słowa, stop-words, brak
-- dopasowania środka słowa — dlatego nie jest tu domyślny).
-- =====================================================================

SET @dbname = DATABASE();

-- --- user: (organization_id, client_name) -----------------------------
-- Filtr po organizacji + prefiks nazwy + ORDER BY client_name z indeksu.
SELECT COUNT(*) INTO @idx_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'user' AND INDEX_NAME = 'idx_org_client_name';

SET @q = IF(@idx_exists = 0,
  'ALTER TABLE `user` ADD INDEX `idx_org_client_name` (`organization_id`, `client_name`)',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- order: (organization_id, status, sent_date) -----------------------
-- Lista „zamówienia do zafakturowania" filtruje po organizacji i statusie
-- ('sent'), a sortuje po `sent_date DESC`.
SELECT COUNT(*) INTO @idx_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND INDEX_NAME = 'idx_org_status_sent';

SET @q = IF(@idx_exists = 0,
  'ALTER TABLE `order` ADD INDEX `idx_org_status_sent` (`organization_id`, `status`, `sent_date`)',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- order: (user_id, status) ------------------------------------------
-- Wyszukiwanie zamówień KONKRETNEGO klienta (najczęstsze zapytanie panelu).
-- Sam `user_id` już jest, ale dołożenie statusu odsiewa niewysłane bez sięgania
-- do wierszy tabeli.
SELECT COUNT(*) INTO @idx_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND INDEX_NAME = 'idx_user_status';

SET @q = IF(@idx_exists = 0,
  'ALTER TABLE `order` ADD INDEX `idx_user_status` (`user_id`, `status`)',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- order: commision -------------------------------------------------
-- Dopasowanie po NAZWIE zamówienia (prefiks). Osobny indeks, bo szukanie po
-- nazwie zdarza się bez zawężenia do klienta w przyszłych widokach.
SELECT COUNT(*) INTO @idx_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order' AND INDEX_NAME = 'idx_commision';

SET @q = IF(@idx_exists = 0,
  'ALTER TABLE `order` ADD INDEX `idx_commision` (`commision`)',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- order_item: order_id ---------------------------------------------
-- Podzapytanie sumujące wartość pozycji (wykrywanie zamówień o zerowej
-- wartości) trafia w `order_item` po `order_id`.
SELECT COUNT(*) INTO @idx_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'order_item' AND INDEX_NAME = 'idx_order_id';

SET @q = IF(@idx_exists = 0,
  'ALTER TABLE `order_item` ADD INDEX `idx_order_id` (`order_id`)',
  'SELECT 1');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
