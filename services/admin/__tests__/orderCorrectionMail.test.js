const test = require('node:test');
const assert = require('node:assert');
const { buildOrderFileName } = require('../../../utils/orderFileName');

// Serwis ładuje bazę — tu tylko czysta funkcja, wyciągnięta bez require całego modułu.
const src = require('fs').readFileSync(require.resolve('../orderCorrectionService.js'), 'utf8');
const fnSrc = src.match(/function resolveCorrectionMailRecipients[\s\S]*?\n}\n/)[0];
const resolveCorrectionMailRecipients = new Function(`${fnSrc}; return resolveCorrectionMailRecipients;`)();
const suffix = src.match(/const CORRECTION_FILE_SUFFIX = '([^']*)'/)[1];

test('plik korekty: HKL_TCN_222_correction', () => {
    assert.equal(buildOrderFileName('HKL', 'TCN', 222, suffix), 'HKL_TCN_222_correction');
});

test('produkcja: mail do klienta z kopiami', () => {
    assert.deepEqual(
        resolveCorrectionMailRecipients({ production: true, redirect: 'x@y.pl', mainRecipient: 'klient@a.pl', bcc: ['all@b.pl'] }),
        { to: 'klient@a.pl', bcc: ['all@b.pl'] }
    );
});

test('test: tylko adres przekierowania, bez kopii; brak adresu = brak maila', () => {
    assert.deepEqual(
        resolveCorrectionMailRecipients({ production: false, redirect: 'pawelwr.121@gmail.com', mainRecipient: 'klient@a.pl', bcc: ['all@b.pl'] }),
        { to: 'pawelwr.121@gmail.com', bcc: null }
    );
    assert.equal(resolveCorrectionMailRecipients({ production: false, redirect: ' ', mainRecipient: 'k@a.pl' }).to, null);
});
