'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareClients } = require('../dbUserSync');

const plik = [
    { pin: '1001', ident: 'KLIENT_A', name: 'A', password: 'x' },
    { pin: '9999', ident: 'NOWY_Z_PLIKU', name: 'Nowy', password: 'y' }
];

test('synchronizacja contractors.txt nie usuwa i nie nadpisuje kont biura (rola staff)', () => {
    const baza = [
        { pin: '1001', ident: 'KLIENT_A', name: 'A', password: 'x', role: null },
        { pin: 'anna', ident: 'STAFF_ANNA', name: 'Anna', password: '$2a$12$hash', role: 'staff' },
        { pin: 'stary', ident: 'USUNIETY', name: 'Stary', password: 'z', role: null }
    ];
    const diff = compareClients(plik, baza);
    assert.deepEqual(diff.toRemove.map((c) => c.ident), ['USUNIETY'], 'znika tylko klient spoza pliku');
    assert.ok(!diff.toUpdate.some((c) => c.ident === 'STAFF_ANNA'));
});

test('wiersz pliku z pinem konta biura nie próbuje wstawić duplikatu', () => {
    const baza = [{ pin: '9999', ident: 'STAFF_X', name: 'X', password: 'h', role: 'Staff' }];
    const diff = compareClients(plik, baza);
    assert.deepEqual(diff.toAdd.map((c) => c.ident), ['KLIENT_A']);
    assert.deepEqual(diff.toRemove, []);
});
