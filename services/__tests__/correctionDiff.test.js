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
const { diffItems, markItems, saveSnapshot, loadSnapshot, dropSnapshot, loadSentItems, planPositions } = require('../correctionDiff');
const { OrderSender } = require('../sendOrderService');
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


/* Stałe numery pozycji w korekcie (Wiktoria, 16.11.2026). */

const sent = (pairs) => pairs.map(([posid, orderpos, extra]) => ({ posid, orderpos, commission: `poz ${orderpos}`, ...extra }));

test('numery: stara pozycja zachowuje numer, nowa = następny wolny, nigdy numer usuniętej', () => {
    // Do PROD poszły 1..4, w korekcie usunięta 4 (id 13), dodana id 20.
    const plan = planPositions(sent([[10, 1], [11, 2], [12, 3], [13, 4]]), [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 20 }]);
    assert.deepEqual([...plan.numbers], [[10, 1], [11, 2], [12, 3], [20, 5]]);
    assert.deepEqual(plan.deleted.map((item) => item.posid), [13]);
});

test('numery w kolejnej korekcie: usunięte wcześniej zostają w pliku i blokują swój numer', () => {
    // Poprzednia korekta: 1, 2 (deleted), 3, 5. Teraz usunięta 1, dodane dwie.
    const prev = sent([[10, 1], [11, 2, { deleted: true }], [12, 3], [20, 5]]);
    const plan = planPositions(prev, [{ id: 12 }, { id: 20 }, { id: 30 }, { id: 31 }]);
    assert.deepEqual([...plan.numbers], [[12, 3], [20, 5], [30, 6], [31, 7]]);
    assert.deepEqual(plan.deleted.map((item) => [item.posid, item.orderpos]), [[10, 1], [11, 2]]);
});

test('plik korekty: kolejność wg numerów z PROD, usunięte z `deleted`, posid bez zmian', () => {
    const items = [12, 20, 30].map((id) => ({ id, asortment_group_number: '71', json_parameters: { B: 1, A: 2 }, parameters_short: {} }));
    const plan = planPositions(sent([[10, 1], [11, 2, { deleted: true }], [12, 3], [20, 5]]), items);
    const sender = new OrderSender({}, { id: 1, order_idx: 7 }, items, {
        orgIdent: 'HKL', userIdent: 'KLIENT', positionNumbers: plan.numbers, deletedItems: plan.deleted
    });
    const out = sender.getData().items.map((item) => [item.posid, item.orderpos, !!item.deleted]);
    assert.deepEqual(out, [[10, 1, true], [11, 2, true], [12, 3, false], [20, 5, false], [30, 6, false]]);
    assert.deepEqual(sender.getData().items[0].commission, 'poz 1', 'usunięta z treścią z poprzedniego pliku');
    assert.deepEqual(sender.shortItems.map((item) => item.orderpos), [3, 5, 6]);
});

test('zwykła wysyłka bez zmian: numery kolejno 1..n, bez `deleted`', () => {
    const items = [5, 9].map((id) => ({ id, orderpos: 7, json_parameters: {}, parameters_short: {} }));
    const out = new OrderSender({}, { id: 1, order_idx: 7 }, items, { orgIdent: 'HKL', userIdent: 'KLIENT' }).getData().items;
    assert.deepEqual(out.map((item) => [item.posid, item.orderpos, 'deleted' in item]), [[5, 1, false], [9, 2, false]]);
});

test('ostatnio wysłany plik: najpierw korekta, cudzy (inne orderid) i uszkodzony pominięte', async () => {
    const outputData = fs.mkdtempSync(path.join(os.tmpdir(), 'korekta-'));
    const write = (name, body) => fs.writeFileSync(path.join(outputData, `${name}.json`), body);
    const names = ['HKL_K_7_correction', 'HKL_K_7'];
    assert.equal(await loadSentItems(names, 42, { outputData }), null, 'brak plików');
    write('HKL_K_7', JSON.stringify({ orderid: 42, items: [{ posid: 1, orderpos: 1 }] }));
    write('HKL_K_7_correction', JSON.stringify({ orderid: 99, items: [{ posid: 5, orderpos: 1 }] }));
    assert.deepEqual(await loadSentItems(names, 42, { outputData }), [{ posid: 1, orderpos: 1 }], 'korekta innego zlecenia');
    write('HKL_K_7_correction', '{"orderid": 42, "items": []}}');
    assert.deepEqual(await loadSentItems(names, 42, { outputData }), [{ posid: 1, orderpos: 1 }], 'uszkodzona korekta');
    write('HKL_K_7_correction', JSON.stringify({ orderid: 42, items: [{ posid: 1, orderpos: 3 }] }));
    assert.deepEqual(await loadSentItems(names, 42, { outputData }), [{ posid: 1, orderpos: 3 }]);
    fs.rmSync(outputData, { recursive: true, force: true });
});

test('PDF korekty: numery z PROD przy pozycjach i przy usuniętych', async () => {
    const before = [makeOrderItem({ id: 1 }), makeOrderItem({ id: 3, group_name: 'VS2', commision: 'Salon' })];
    const after = [makeOrderItem({ id: 1 }), makeOrderItem({ id: 9 })];
    const plan = planPositions(sent([[1, 1], [2, 2, { deleted: true }], [3, 3]]), after);
    const correction = markItems(after, diffItems(before, after), plan);
    const { cleanOrderItems } = await orderService.jsonTextBackToMap(after);
    const html = renderOrderPdfHtml({
        orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
        cleanOrderItems, sendData: {}, orderNr: '197', showBoth: true, correction, lang: 'pl'
    });
    const numbers = [...html.matchAll(/<tbody class="pos[^"]*">\s*<tr>\s*<td><span class="pdf-val">(\d+)</g)].map((m) => m[1]);
    assert.deepEqual(numbers, ['1', '4']);
    assert.match(html, /class="correction-removed"[\s\S]*3\. Rolety \/ VS2 — Salon/);
});
