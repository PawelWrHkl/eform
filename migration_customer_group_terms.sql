-- Migration: warunki handlowe PER GRUPA ASORTYMENTOWĄ dla klientów eForm.
--
-- Tło: cenniki, rabaty i dopłaty NIE są globalne per klient — siedzą w
-- `data/<grupa>/data/<język>/prod.txt` w kolumnie `PARAM_SCRIPTS` jako
-- `ORGANIZACJA/KLIENT/PARAMETR=param-<PARAMETR>-<WARIANT>.js`, np.
--
--   HKL/TCN/CENA=param-CENA-Cmul1.3.js      (cennik C × 1,3)
--   HKL/TCN/CENA_RABAT=param-CENA_RABAT-0.js (rabat zerowy)
--   HKL/TCN/SUB___CENA=param-SUB___CENA-J.js (osobny cennik ceny klienta)
--
-- oraz kolekcje tkanin w `PARAMDICT_ALIASES`
-- (`HKL/TCN/KOLOR=paramdict-KOLOR-ZONNELUX.txt`).
--
-- ⚠️ Te pliki generuje APLIKACJA ZEWNĘTRZNA (mtime zmienia się co kilka dni,
-- w eForm nie ma ani jednego zapisu do nich — jedyny kierunek to
-- `services/paramdictConfigSync.js`, plik → baza). Dlatego eForm NIE dopisuje
-- się do `prod.txt`: klienci zakładani w eForm dostają wpisy w tej tabeli, a
-- resolver (`services/orgCustomers/groupTerms.js`) nakłada je na to, co
-- wyczytał z pliku. Stare konta nie mają tu ani jednego wiersza i działają
-- dokładnie jak dotąd.
--
-- Jeden wiersz = jeden klient w jednej grupie. Mapy `scripts`/`collections`
-- trzymamy jako JSON, bo dokładnie tak wygląda dana w pliku (parametr → plik),
-- a liczba parametrów różni się między grupami.

CREATE TABLE IF NOT EXISTS `customer_group_terms` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `organization_id` INT NOT NULL,
  `group_number` VARCHAR(10) NOT NULL,

  -- { "CENA": "param-CENA-Cmul1.3.js", "CENA_RABAT": "param-CENA_RABAT-0.js", … }
  `scripts` JSON DEFAULT NULL,
  -- { "KOLOR": "paramdict-KOLOR-ZONNELUX.txt", … }
  `collections` JSON DEFAULT NULL,

  -- Odpowiednik wiersza `USERS` z prod.txt: czy klient w ogóle widzi tę grupę.
  `has_access` TINYINT(1) NOT NULL DEFAULT 1,

  -- Wygodne skróty do listy w panelu — wariant cennika ('C', 'Cmul1.3', 'K')
  -- i rabatu ('0'), wyprowadzone z nazw plików przy zapisie.
  `price_variant` VARCHAR(30) DEFAULT NULL,
  `discount_variant` VARCHAR(30) DEFAULT NULL,

  `notes` VARCHAR(255) DEFAULT NULL,
  `created_by_user_id` INT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY `uniq_cgt_user_group` (`user_id`, `group_number`),
  KEY `idx_cgt_org_group` (`organization_id`, `group_number`),
  CONSTRAINT `fk_cgt_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
