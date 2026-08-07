/**
 * Migracja: `position_statuses.order_pos` INT → VARCHAR(32).
 *
 * ⚠️ Powód: plik `status.txt` z produkcji niesie w kolumnie ORDERPOS wartości,
 * które NIE SĄ liczbami — podpozycje w schemacie `1-1`, `1-2`, a także kody
 * produkcyjne w rodzaju `B793638`. MySQL odrzucał je błędem
 * „Incorrect integer value for column 'order_pos'", więc statusy tych pozycji
 * po prostu nie wchodziły do bazy — cicho, przy każdym przebiegu importu.
 *
 * Skrypt jest idempotentny: sprawdza bieżący typ kolumny i nic nie robi, jeśli
 * jest już tekstowa. Uruchomienie: `node scripts/alterPositionStatusesPos.js`
 */

require('dotenv').config();
const { selectQuery, connetToDb } = require('../db/core');

(async () => {
  const cols = await selectQuery('SHOW COLUMNS FROM position_statuses LIKE ?', ['order_pos']);
  const current = cols && cols[0] ? cols[0].Type : null;
  if (!current) {
    console.error('Brak kolumny position_statuses.order_pos');
    process.exit(1);
  }
  if (/varchar/i.test(current)) {
    console.log(`order_pos jest już tekstowa (${current}) — nic do zrobienia`);
    process.exit(0);
  }

  const conn = await connetToDb();
  try {
    await conn.query('ALTER TABLE position_statuses MODIFY COLUMN `order_pos` VARCHAR(32) NULL');
    const [after] = await conn.query("SHOW COLUMNS FROM position_statuses LIKE 'order_pos'");
    console.log(`order_pos: ${current} → ${after[0].Type}`);
  } finally {
    await conn.end();
  }
  process.exit(0);
})().catch((err) => { console.error('Migracja nieudana:', err.message); process.exit(1); });
