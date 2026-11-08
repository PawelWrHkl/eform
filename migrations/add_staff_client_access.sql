-- Migration: dostęp kont biura (`user.role = 'staff'`) do klientów.
-- Ustawia admin w /admin/users (sekcja „Dostęp biura"); czyta services/staffAccess.js.
--   client_user_id IS NULL — wszyscy klienci organizacji, także założeni później
--                            (checkbox „także przyszli klienci", decyzja właściciela 5);
--   client_user_id = id    — jeden wskazany klient.
-- Konto biura, organizacja albo klient usunięci (np. synchronizacja contractors.txt)
-- zabierają swoje wiersze (ON DELETE CASCADE).
-- Rola `staff` nie wymaga migracji: `user.role` to VARCHAR(100).
-- Idempotentna — można uruchamiać wielokrotnie.

CREATE TABLE IF NOT EXISTS `staff_client_access` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `staff_user_id` INT NOT NULL,
  `organization_id` INT NOT NULL,
  `client_user_id` INT NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sca_staff_org` (`staff_user_id`, `organization_id`),
  KEY `idx_sca_client` (`client_user_id`),
  KEY `idx_sca_org` (`organization_id`),
  CONSTRAINT `fk_sca_staff` FOREIGN KEY (`staff_user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sca_org` FOREIGN KEY (`organization_id`) REFERENCES `organization` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sca_client` FOREIGN KEY (`client_user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
