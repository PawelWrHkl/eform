'use strict';

/**
 * Oznaczenia zmian w PDF-ie korekty (services/correctionDiff.js + order-pdf.njk):
 * zmieniona komórka `chg`, nowa pozycja `pos--new`, usunięte pod tabelą.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { diffItems, markItems, saveSnapshot, loadSnapshot, dropSnapshot } = require('../correctionDiff');
const { renderOrderPdfHtml } = require('../mailBot/pdfGenerator');
const orderService = require('../orderService.js');
const { makeOrderItem } = require('./fixtures/subPriceOrder');

const withModel = (item, model) => ({
    ...item,
    json_parameters_desc: item.json_parameters_desc.map(([k, p]) => [k, k === 'MODEL' ? { ...p, option_value: model } : p])
});

test('diff: zmieniony parametr, nowa i usunięta pozycja, nazwa i komentarz', () => {
    const before = [makeOrderItem({ id: 1 }), makeOrderItem({ id: 2, commision: 'Kuchnia' }), makeOrderItem({ id: 3, group_name: 'VS2', commision: 'Salon' })];
    const after = [
        withModel(makeOrderItem({ id: 1 }), 'H60'),
        makeOrderItem({ id: 2, commision: 'Kuchnia 2', comment: 'pilne' }),
        makeOrderItem({ id: 9 })
    ];
    const diff = diffItems(before, after);
    assert.deepEqual(diff.changed.get(1), ['MODEL']);
    assert.deepEqual(diff.changed.get(2), ['__commision', '__comment']);
    assert.deepEqual([...diff.added], [9]);
    assert.deepEqual(diff.removed.map(i => i.id), [3]);
});

test('diff: bez zmian → nic do oznaczenia', () => {
    const items = [makeOrderItem({ id: 1 })];
    const info = markItems(items, diffItems([makeOrderItem({ id: 1 })], items));
    assert.equal(info.marked, false);
    assert.deepEqual(items[0].correctionChanged, []);
});

test('PDF: kolor tylko na zmienionej komórce, znaczek przy nowej pozycji, lista usuniętych', async () => {
    const before = [makeOrderItem({ id: 1 }), makeOrderItem({ id: 3, group_name: 'VS2', commision: 'Salon' })];
    const after = [withModel(makeOrderItem({ id: 1 }), 'H60'), makeOrderItem({ id: 9 })];
    const correction = markItems(after, diffItems(before, after));
    const { cleanOrderItems } = await orderService.jsonTextBackToMap(after);
    const html = renderOrderPdfHtml({
        orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
        cleanOrderItems, sendData: {}, orderNr: '197', showBoth: true, correction, lang: 'pl'
    });
    assert.equal((html.match(/class="chg"/g) || []).length, 1, 'jedna zmieniona komórka (MODEL)');
    assert.match(html, /<td class="chg"><span class="pdf-val">H60/);
    assert.equal((html.match(/pos--new/g) || []).length, 1);
    assert.match(html, /class="chg-badge"/);
    assert.match(html, /class="correction-note"/);
    assert.match(html, /class="correction-removed"[\s\S]*Rolety \/ VS2 — Salon/);
});

test('PDF bez korekty: żadnych oznaczeń', async () => {
    const { cleanOrderItems } = await orderService.jsonTextBackToMap([makeOrderItem()]);
    const html = renderOrderPdfHtml({ orderDetails: { id: 1 }, cleanOrderItems, sendData: {}, orderNr: '1', lang: 'pl' });
    assert.doesNotMatch(html, /chg|pos--new|correction-/);
});

test('stan „przed”: zapis, odczyt, usunięcie; brak pliku = null', async () => {
    const outputData = fs.mkdtempSync(path.join(os.tmpdir(), 'korekta-'));
    await saveSnapshot(42, [{ id: 1, commision: 'A' }], { outputData });
    assert.deepEqual(await loadSnapshot(42, { outputData }), [{ id: 1, commision: 'A' }]);
    await dropSnapshot(42, { outputData });
    assert.equal(await loadSnapshot(42, { outputData }), null);
    fs.rmSync(outputData, { recursive: true, force: true });
});
