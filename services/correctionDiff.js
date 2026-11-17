/**
 * Co zmieniła korekta wysłanego zlecenia — do oznaczenia kolorem w PDF-ie
 * korekty (services/mailBot/order-pdf.njk: komórka `chg`, pozycja `pos--new`,
 * lista usuniętych). Stan „przed” zapisuje otwarcie korekty (`saveSnapshot`,
 * services/admin/orderCorrectionService.js `openCorrection`) w
 * `outputData/order-corrections/<id>.json`; wysyłka porównuje go z bieżącymi
 * pozycjami (`diffItems`) i usuwa plik. Brak pliku (korekta otwarta przed
 * 13.11.2026) = PDF bez oznaczeń.
 *
 * Numery pozycji korekty (`loadSentItems` + `planPositions`): z ostatnio
 * wysłanego pliku, a gdy go nie ma — ze stanu „przed” (`order_item.orderpos`).
 */

'use strict';

const path = require('path');
const { log } = require('../utils/logging');

function resolveDeps(deps = {}) {
    return {
        fs: deps.fs || require('fs').promises,
        outputData: deps.outputData || require('../config').outputData
    };
}

function snapshotPath(orderId, outputData) {
    return path.join(outputData, 'order-corrections', `${parseInt(orderId, 10)}.json`);
}

/** Pozycje zlecenia w chwili otwarcia korekty (`db.getOrderDataToSend(...).orderItems`). */
async function saveSnapshot(orderId, items, deps) {
    const d = resolveDeps(deps);
    const file = snapshotPath(orderId, d.outputData);
    await d.fs.mkdir(path.dirname(file), { recursive: true });
    await d.fs.writeFile(file, JSON.stringify({ orderId: Number(orderId), savedAt: new Date().toISOString(), items }), 'utf-8');
}

/** @returns {Promise<object[]|null>} pozycje „przed” albo `null`, gdy pliku nie ma */
async function loadSnapshot(orderId, deps) {
    const d = resolveDeps(deps);
    try {
        return JSON.parse(await d.fs.readFile(snapshotPath(orderId, d.outputData), 'utf-8')).items || null;
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function dropSnapshot(orderId, deps) {
    const d = resolveDeps(deps);
    await d.fs.unlink(snapshotPath(orderId, d.outputData)).catch(() => {});
}

/**
 * Pozycje z pliku, który ostatnio poszedł do produkcji — pierwszy z `fileNames`
 * (bez `.json`: poprzednia korekta, potem zlecenie) należący do tego zlecenia.
 * Katalog `out` na teście jest wspólny kilku środowisk, stąd sprawdzenie `orderid`;
 * uszkodzony plik traktujemy jak brak.
 * @returns {Promise<object[]|null>}
 */
async function loadSentItems(fileNames, orderId, deps) {
    const d = resolveDeps(deps);
    for (const name of fileNames) {
        let data;
        try {
            data = JSON.parse(await d.fs.readFile(path.join(d.outputData, `${name}.json`), 'utf-8'));
        } catch (err) {
            if (err.code !== 'ENOENT') log(`Korekta ${orderId}: pominięto plik ${name}.json:`, err.message);
            continue;
        }
        if (Number(data?.orderid) === Number(orderId) && Array.isArray(data.items)) return data.items;
    }
    return null;
}

/**
 * Stałe numery pozycji w pliku korekty (Wiktoria, 16.11.2026): pozycja zachowuje
 * numer, z którym poszła do produkcji, nowa dostaje kolejny wolny (nigdy numer
 * usuniętej), a usunięta zostaje w pliku (`deleted`). Czysta funkcja.
 * @param {object[]} sentItems `items` ostatnio wysłanego pliku (`posid`, `orderpos`)
 * @param {object[]} items bieżące pozycje (`order_item`, kolejność bazy)
 * @returns {{ numbers: Map<number, number>, deleted: object[] }}
 */
function planPositions(sentItems, items) {
    const sent = (sentItems || []).filter(item => Number(item.orderpos) > 0);
    const sentPos = new Map(sent.map(item => [Number(item.posid), Number(item.orderpos)]));
    let next = Math.max(0, ...sentPos.values()) + 1;
    const numbers = new Map((items || []).map(item => [Number(item.id), sentPos.get(Number(item.id)) ?? next++]));
    const deleted = sent.filter(item => !numbers.has(Number(item.posid)));
    return { numbers, deleted };
}

function parseDesc(raw) {
    let parsed = raw;
    try {
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch (_) {
        return [];
    }
    return Array.isArray(parsed) ? parsed : [];
}

/** Wartość komórki tak, jak ją widać w dokumencie (orderService.jsonTextBackToMap). */
function cellValue(param) {
    if (param && typeof param === 'object') {
        if (!('option_value' in param)) return '';
        return param.option_description ? `${param.option_value} - ${param.option_description}` : String(param.option_value ?? '');
    }
    return param === null || param === undefined ? '' : String(param);
}

/** Klucz parametru → wartość; nazwa pozycji i komentarz jako `__commision` / `__comment`. */
function displayMap(item) {
    const map = new Map();
    for (const entry of parseDesc(item?.json_parameters_desc)) {
        if (Array.isArray(entry) && entry.length >= 2) map.set(String(entry[0]), cellValue(entry[1]));
    }
    map.set('__commision', String(item?.commision ?? '').trim());
    map.set('__comment', String(item?.comment ?? '').trim());
    return map;
}

/**
 * Porównanie pozycji po `order_item.id` (czysta funkcja).
 * @returns {{ changed: Map<number, string[]>, added: Set<number>, removed: object[] }}
 */
function diffItems(before, after) {
    const prev = new Map((before || []).map(item => [Number(item.id), item]));
    const changed = new Map();
    const added = new Set();
    for (const item of after || []) {
        const id = Number(item.id);
        const old = prev.get(id);
        if (!old) {
            added.add(id);
            continue;
        }
        const a = displayMap(old);
        const b = displayMap(item);
        const keys = [...new Set([...a.keys(), ...b.keys()])].filter(key => (a.get(key) ?? '') !== (b.get(key) ?? ''));
        if (keys.length) changed.set(id, keys);
    }
    const afterIds = new Set((after || []).map(item => Number(item.id)));
    const removed = (before || []).filter(item => !afterIds.has(Number(item.id)));
    return { changed, added, removed };
}

/**
 * Znaczniki na pozycjach (te same obiekty trafiają do `cleanOrderItems` → `rowObj.item`)
 * + dane do PDF-u (`options.correction` w pdfGenerator.generateOrderDocuments).
 */
function markItems(items, diff, positions) {
    // `positions` (planPositions): numer pozycji w PDF-ie = numer z produkcji, także przy usuniętych.
    const deletedPos = new Map((positions?.deleted || []).map(item => [Number(item.posid), Number(item.orderpos)]));
    for (const item of items || []) {
        const id = Number(item.id);
        item.correctionNew = diff.added.has(id);
        item.correctionChanged = diff.changed.get(id) || [];
        item.correctionPos = positions?.numbers.get(id) ?? null;
    }
    return {
        marked: diff.added.size > 0 || diff.changed.size > 0 || diff.removed.length > 0,
        removed: diff.removed.map(item => ({
            orderpos: deletedPos.get(Number(item.id)) ?? null,
            department: item.department || '',
            group_name: item.group_name || '',
            commision: item.commision || ''
        }))
    };
}

module.exports = { saveSnapshot, loadSnapshot, dropSnapshot, loadSentItems, planPositions, displayMap, diffItems, markItems };
