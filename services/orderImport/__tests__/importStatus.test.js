'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildImportStatusText } = require('../importStatus');

test('buildImportStatusText: nagłówek + wiersz na pozycję, kolumny tabulatorem', () => {
  const text = buildImportStatusText(
    { orgIdent: 'HKL', userIdent: 'Azra', orderIdx: '77', date: '2026-10-29' },
    [{ orderpos: 4, commision: 'abcd' }, { orderpos: 5, commision: null }]
  );
  assert.equal(text, [
    'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tCOMMISION\tREDATE',
    'HKL\tAzra\t77\t4\tabcd\t2026-10-29',
    'HKL\tAzra\t77\t5\t\t2026-10-29',
    ''
  ].join('\r\n'));
});

test('buildImportStatusText: tabulator i nowa linia w wartości nie rozbijają kolumn', () => {
  const text = buildImportStatusText(
    { orgIdent: 'Luxan\tGmbH', userIdent: 'A\nB', orderIdx: null, date: '2026-10-29' },
    [{ orderpos: 1, commision: 'x\ty' }]
  );
  const row = text.split('\r\n')[1].split('\t');
  assert.equal(row.length, 6);
  assert.deepEqual(row, ['Luxan GmbH', 'A B', '', '1', 'x y', '2026-10-29']);
});
