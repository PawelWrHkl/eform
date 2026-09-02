-- Migration: Add remember_tokens table
-- Description: Persistent long-lived "remember me" login tokens, independent of
-- the in-memory express-session store (which is cleared on every server restart).

CREATE TABLE IF NOT EXISTS `remember_tokens` (
    `token` CHAR(64) NOT NULL PRIMARY KEY,
    `pin` VARCHAR(64) NOT NULL,
    `created_at` DATETIME NOT NULL,
    `expires_at` DATETIME NOT NULL,
    INDEX `idx_remember_tokens_pin` (`pin`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
