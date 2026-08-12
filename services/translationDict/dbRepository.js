/**
 * Database repository for translation dictionary.
 * Handles table creation, upsert, and query operations.
 */

const { connetToDb, selectQuery } = require('../../db/core');
const { log } = require('../../utils/logging');

const TABLE_NAME = 'translation_dictionary';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_number VARCHAR(10) NOT NULL,
    source_type ENUM('param', 'paramdict') NOT NULL,
    param_name VARCHAR(255) NOT NULL,
    value_key VARCHAR(500) DEFAULT NULL,
    lang VARCHAR(5) NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_translation (group_number, source_type, param_name, value_key(191), lang)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Nazwy DZIAŁU i GRUPY produktowej w zadanym języku.
 *
 * ⚠️ Te dwie kolumny (`order_item.department`, `order_item.group_name`) NIE są
 * parametrami z konfiguratora i nie ma ich w `translation_dictionary` — są
 * zapisywane w języku osoby zakładającej pozycję. Tłumaczenia trzymają
 * natomiast tabele `product_group` i `department`, każda z kolumnami
 * `name_pl … name_fr`, powiązane przez `product_group.department_id`.
 * Klucz dopasowania: `order_item.asortment_group_number` = `product_group.group_number`.
 *
 * @param {string[]} groupNumbers numery grup asortymentowych z pozycji
 * @param {string} lang kod języka z `availabeLanguages` (używany w nazwie kolumny)
 * @returns {Promise<Map<string, {group: string|null, department: string|null}>>}
 */
async function getGroupDepartmentNames(groupNumbers, lang) {
  const wynik = new Map();
  if (!groupNumbers || !groupNumbers.length) return wynik;

  // ⚠️ Język trafia do NAZWY KOLUMNY, więc nie może pochodzić wprost z wejścia —
  // dopuszczamy wyłącznie kody z konfiguracji aplikacji.
  const { availabeLanguages } = require('../../config');
  const kod = String(lang || '').toLowerCase();
  if (!availabeLanguages.includes(kod)) return wynik;

  const kolumna = `name_${kod}`;
  const placeholders = groupNumbers.map(() => '?').join(', ');
  try {
    const rows = await selectQuery(
      `SELECT pg.group_number, pg.\`${kolumna}\` AS grupa, d.\`${kolumna}\` AS dzial
         FROM product_group pg
         LEFT JOIN department d ON d.id = pg.department_id
        WHERE pg.group_number IN (${placeholders})`,
      groupNumbers
    );
    for (const row of rows || []) {
      wynik.set(String(row.group_number), {
        group: row.grupa || null,
        department: row.dzial || null
      });
    }
  } catch (err) {
    // Brak tłumaczenia nazw nie może wywalić generowania dokumentu — zostają
    // wartości zapisane na pozycji.
    log('[translationDict] nazwy działu/grupy:', err.message);
  }
  return wynik;
}

/**
 * Ensure the translation_dictionary table exists.
 */
async function ensureTable() {
  const conn = await connetToDb();
  try {
    await conn.query(CREATE_TABLE_SQL);
  } finally {
    await conn.end();
  }
}

/**
 * Get current MySQL server timestamp (avoids JS/MySQL timezone mismatch).
 * @returns {Promise<Date>}
 */
async function getMySQLNow() {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query('SELECT NOW() as now');
    return rows[0].now;
  } finally {
    await conn.end();
  }
}

/**
 * Upsert a batch of translation entries.
 * Uses INSERT ... ON DUPLICATE KEY UPDATE for efficient bulk upsert.
 *
 * @param {Array<{groupNumber, sourceType, paramName, valueKey, lang, description, version}>} entries
 * @returns {Promise<{inserted: number, updated: number}>}
 */
async function upsertBatch(entries) {
  if (!entries.length) return { inserted: 0, updated: 0 };

  const conn = await connetToDb();
  try {
    const BATCH_SIZE = 500;
    let totalAffected = 0;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(',\n');
      const values = [];

      for (const entry of batch) {
        values.push(
          entry.groupNumber,
          entry.sourceType,
          entry.paramName,
          entry.valueKey || '',
          entry.lang,
          entry.description
        );
      }

      const sql = `
        INSERT INTO ${TABLE_NAME}
          (group_number, source_type, param_name, value_key, lang, description)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          description = VALUES(description),
          updated_at = CURRENT_TIMESTAMP
      `;

      const [result] = await conn.query(sql, values);
      totalAffected += result.affectedRows;
    }

    return { affected: totalAffected };
  } finally {
    await conn.end();
  }
}

/**
 * Remove entries for a group that are no longer in the current file set.
 * Called after upsert — deletes rows not updated in this sync cycle.
 *
 * @param {string} groupNumber
 * @param {Date} syncStartTime - Timestamp before sync started
 */
async function removeStaleEntries(groupNumber, syncStartTime) {
  const conn = await connetToDb();
  try {
    const sql = `DELETE FROM ${TABLE_NAME} WHERE group_number = ? AND updated_at < ?`;
    const [result] = await conn.query(sql, [groupNumber, syncStartTime]);
    return result.affectedRows;
  } finally {
    await conn.end();
  }
}

/**
 * Query translations for a specific param in a target language.
 *
 * @param {string} groupNumber
 * @param {string} paramName
 * @param {string} lang
 * @param {string} sourceType - 'param' or 'paramdict'
 * @returns {Promise<Array>}
 */
async function getTranslations(groupNumber, paramName, lang, sourceType = null) {
  const conn = await connetToDb();
  try {
    let sql = `SELECT * FROM ${TABLE_NAME} WHERE group_number = ? AND param_name = ? AND lang = ?`;
    const params = [groupNumber, paramName, lang];

    if (sourceType) {
      sql += ' AND source_type = ?';
      params.push(sourceType);
    }

    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

/**
 * Get all translations for a group and language.
 *
 * @param {string} groupNumber
 * @param {string} lang
 * @returns {Promise<{params: Object, paramdict: Object}>}
 */
async function getGroupTranslations(groupNumber, lang) {
  const conn = await connetToDb();
  try {
    const sql = `SELECT * FROM ${TABLE_NAME} WHERE group_number = ? AND lang = ? ORDER BY source_type, param_name`;
    const [rows] = await conn.query(sql, [groupNumber, lang]);

    const result = { params: {}, paramdict: {} };
    for (const row of rows) {
      if (row.source_type === 'param') {
        result.params[row.param_name] = row.description;
      } else {
        if (!result.paramdict[row.param_name]) {
          result.paramdict[row.param_name] = {};
        }
        result.paramdict[row.param_name][row.value_key] = row.description;
      }
    }

    return result;
  } finally {
    await conn.end();
  }
}

/**
 * Get sync status: last sync time and counts per group.
 * @returns {Promise<Array>}
 */
async function getSyncStatus() {
  const conn = await connetToDb();
  try {
    const sql = `
      SELECT group_number, COUNT(*) as entry_count,
             MAX(updated_at) as last_synced
      FROM ${TABLE_NAME}
      GROUP BY group_number
      ORDER BY group_number
    `;
    const [rows] = await conn.query(sql);
    return rows;
  } finally {
    await conn.end();
  }
}

module.exports = {
  ensureTable,
  getMySQLNow,
  upsertBatch,
  removeStaleEntries,
  getTranslations,
  getGroupTranslations,
  getSyncStatus,
  getGroupDepartmentNames
};
