'use strict';

/**
 * Raport statusu importu dla każdego zaimportowanego zlecenia.
 * Po każdym imporcie wysyłany jest nowy plik `import-<timestamp>.txt`
 * do katalogu /import-status/ na tym samym FTP, z którego czytany jest import.
 *
 * Jeden wiersz na pozycję zlecenia; kolumny rozdzielone tabulatorem.
 */

const { selectQuery } = require('../../db/core');
const { uploadImportStatus } = require('./ftpClient');

const HEADER = ['ORGANIZATIONIDENT', 'USERIDENT', 'ORDERNO', 'ORDERPOS', 'COMMISION', 'REDATE'];

// Tabulator ani znak nowej linii nie może trafić do wartości, bo rozwali kolumny.
function cell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ');
}

/**
 * @param {object} meta
 * @param {string} meta.orgIdent
 * @param {string} meta.userIdent
 * @param {string|null} meta.orderIdx
 * @param {string} meta.date            Data w formacie RRRR-MM-DD
 * @param {Array<{orderpos:number, commision:string|null}>} items
 * @returns {string}
 */
function buildImportStatusText({ orgIdent, userIdent, orderIdx, date }, items) {
  const lines = items.map((item) => [
    orgIdent, userIdent, orderIdx ?? '', item.orderpos, item.commision ?? '', date
  ].map(cell).join('\t'));
  return [HEADER.join('\t'), ...lines].join('\r\n') + '\r\n';
}

/**
 * Pobiera pozycje zamówienia i wysyła plik statusu. Rzuca przy błędzie FTP/DB,
 * wywołujący decyduje co zrobić (import już się udał).
 */
async function publishImportStatus({ orderId, orderIdx, user }) {
  const items = await selectQuery(
    'SELECT orderpos, commision FROM order_item WHERE order_id = ? ORDER BY orderpos',
    orderId
  );
  const text = buildImportStatusText({
    orgIdent: user.org_ident || '',
    userIdent: user.ident || '',
    orderIdx,
    date: new Date().toLocaleDateString('sv-SE')
  }, items);
  await uploadImportStatus(`import-${Date.now()}.txt`, text);
}

module.exports = { buildImportStatusText, publishImportStatus };
