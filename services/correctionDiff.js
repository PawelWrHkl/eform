/**
 * Co zmieniła korekta wysłanego zlecenia — do oznaczenia kolorem w PDF-ie
 * korekty (services/mailBot/order-pdf.njk: komórka `chg`, pozycja `pos--new`,
 * lista usuniętych). Stan „przed” zapisuje otwarcie korekty (`saveSnapshot`,
 * services/admin/orderCorrectionService.js `openCorrection`) w
 * `outputData/order-corrections/<id>.json`; wysyłka porównuje go z bieżącymi
 * pozycjami (`diffItems`) i usuwa plik. Brak pliku (korekta otwarta przed
 * 13.11.2026) = PDF bez oznaczeń.
 */

'use strict';

const path = require('path');

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
function markItems(items, diff) {
    for (const item of items || []) {
        const id = Number(item.id);
        item.correctionNew = diff.added.has(id);
        item.correctionChanged = diff.changed.get(id) || [];
    }
    return {
        marked: diff.added.size > 0 || diff.changed.size > 0 || diff.removed.length > 0,
        removed: diff.removed.map(item => ({
            department: item.department || '',
            group_name: item.group_name || '',
            commision: item.commision || ''
        }))
    };
}

module.exports = { saveSnapshot, loadSnapshot, dropSnapshot, displayMap, diffItems, markItems };
