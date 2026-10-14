/**
 * Robot kopiowania pozycji — warstwa nocnego przebiegu (`--kopiowanie`)
 * i silnik narzędzia `scripts/copyLineSimulation.js`.
 *
 * Skąd: zgłoszenie Ryver (verticale, rzymskie, żaluzje drewniane — „przy
 * kopiowaniu giną pola") i polecenie KK z 2026-10-14: robot ma sam składać
 * pozycje, kopiować je i sprawdzać pole po polu wartości, opcje, wymiary,
 * kolory, elementy dodatkowe i ceny. Przyczyny znalezione 13.10 —
 * PROJECT_OVERVIEW.md, Changelog 2026-10-13.
 *
 * Dwa rodzaje przypadków:
 *  1. **Wygenerowane** — pozycja wzorcowa to prawdziwa pozycja z bazy
 *     (co noc inna: losowanie z ziarnem z daty), zapisana w zleceniu symulatora
 *     i raz zapisana przez formularz (to jest stan odniesienia). Potem kopia
 *     każdą ścieżką, zapis BEZ zmian i porównanie pole po polu
 *     (copyCompare.js) — kopia bez zmian ma być identyczna:
 *       - „wczytaj ostatnią konfigurację" (tak kopiuje Ryver), łańcuchowo;
 *       - „Duplikuj": kopia w bazie, potem otwarcie i zapis bez zmian;
 *       - walidacja: ostatnia konfiguracja z wyczyszczonym polem wymaganym —
 *         zapis MA zostać zablokowany.
 *  2. **Scenariusze Ryver** (copyLineScenarios.js) — kopia + kroki jak
 *     u klienta (zmiana modelu, szerokości…), pilnowane wskazane pola.
 *
 * ⚠️ ZAPISUJE POZYCJE — wyłącznie w zleceniu symulatora
 * (`CONFIGTEST_SIM_ORDER_ID`) i usuwa je na końcu przypadku. Niczego nie
 * wysyła (zlecenie nie jest zamawiane). Odmawia przy `NODE_ENV=prod` i adresie
 * produkcji. Tempo: jedna przeglądarka, przypadki po kolei, przerwa między
 * nimi, limit czasu przebiegu.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { log } = require('./logger');
const { compareSavedPositions, missingDescriptions, summarizeDifferences, parseJson } = require('./copyCompare');
const { SCENARIOS } = require('./copyLineScenarios');

const SAVE_BUTTON_DELAY_MS = 11500; // main.js podpina #show-button 10 s po zbudowaniu formularza
const DEFAULT_CASES = 24;
// Zmierzone 14.10: przypadek wygenerowany ~105 s (5 zapisów, każdy na stronie nowej
// pozycji czeka 10 s), 8 scenariuszy ~5 min → 24 przypadki ≈ 45 min. Nocny przebieg
// kończy grupy ok. 02:45, więc koniec ok. 03:35 — daleko przed watchdogiem 05:30.
const DEFAULT_BUDGET_MIN = 50;
const DEFAULT_PAUSE_MS = 500;
/** Zgłoszone przez Ryver (14, 24, 59) i z uszkodzonymi kopiami w danych produkcji (73, 80). */
const DEFAULT_PRIORITY_GROUPS = ['14', '24', '59', '73', '80'];
const MAX_DIFFERENCES_KEPT = 200;

const PATH_LABEL = Object.freeze({
  ostatnia: '„wczytaj ostatnią konfigurację"',
  duplikat: '„Duplikuj" → edycja → zapis',
  'duplikat-baza': '„Duplikuj" (kopia w bazie)',
  otwarcie: 'otwarcie zapisanej pozycji',
  wymagane: 'walidacja pustego pola wymaganego',
  przygotowanie: 'przygotowanie pozycji wzorcowej'
});

const BROWSER_LABEL = Object.freeze({
  chromium: 'Chromium', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', webkit: 'WebKit (silnik Safari)'
});

/** Rodzaje problemów spoza porównania pól (te z porównania: copyCompare.KIND). */
const EXTRA_PRIORITY = Object.freeze({
  ROZJAZD_FORMULARZA: 'HIGH',
  ZAPIS_ZABLOKOWANY: 'P1',
  ZAPIS_PRZESZEDL: 'P1',
  BLAD_TESTU: 'MEDIUM'
});

const appUrlFromEnv = () => (process.env.CONFIGTEST_APP_URL || 'http://localhost:8000').replace(/\/$/, '');

/** Powód odmowy albo null. Robot zapisuje pozycje — nigdy na produkcji. */
function refuseReason(appUrl = appUrlFromEnv()) {
  if (process.env.NODE_ENV === 'prod') return 'NODE_ENV=prod — robot kopiowania zapisuje pozycje, działa tylko na środowisku testowym';
  if (/31\.70\.87\.147|e-orders\.eu/i.test(appUrl)) return `adres ${appUrl} to produkcja — odmowa`;
  const dbHost = String(process.env.DATABASE_HOST || '');
  if (dbHost.includes('31.70.87.147') || (/^(localhost|127\.0\.0\.1)$/.test(dbHost) && String(process.env.DATABASE_PORT) === '8001')) {
    return `baza ${dbHost}:${process.env.DATABASE_PORT} wygląda na produkcję (tunel :8001) — odmowa`;
  }
  const missing = ['CONFIGTEST_SIM_PIN', 'CONFIGTEST_SIM_PASSWORD', 'CONFIGTEST_SIM_ORDER_ID', 'DATABASE_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) return `brak w .env: ${missing.join(', ')}`;
  return null;
}

const listEnv = (value, fallback) => (value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : fallback);

/** Ziarno z daty — co noc inne pozycje wzorcowe, a ten sam dzień da się powtórzyć. */
function seedFromDate(date = new Date()) {
  return Number(date.toISOString().slice(0, 10).replace(/-/g, ''));
}

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Które grupy dostają przypadki: priorytetowe podwójnie, reszta raz, po kolei
 * w kółko, aż do `total`.
 */
function allocateCases(groupCodes, total, priority = DEFAULT_PRIORITY_GROUPS) {
  const codes = groupCodes.map(String);
  const first = priority.map(String).filter((g) => codes.includes(g));
  const weighted = [...first, ...first, ...codes.filter((g) => !first.includes(g))];
  if (!weighted.length) return [];
  return Array.from({ length: total }, (_, i) => weighted[i % weighted.length]);
}

async function launchBrowser(name, { headed = false } = {}) {
  const pw = require('playwright');
  const args = ['--no-sandbox'];
  if (name === 'chromium') return pw.chromium.launch({ headless: !headed, args });
  if (name === 'chrome') return pw.chromium.launch({ channel: 'chrome', headless: !headed, args });
  if (name === 'msedge' || name === 'edge') return pw.chromium.launch({ channel: 'msedge', headless: !headed, args });
  if (name === 'firefox') return pw.firefox.launch({ headless: !headed });
  if (name === 'webkit' || name === 'safari') return pw.webkit.launch({ headless: !headed });
  throw new Error(`nieznana przeglądarka ${name} (chromium, chrome, msedge, firefox, webkit)`);
}

// ── strona ─────────────────────────────────────────────────────────────────

async function waitIdle(page, settleMs = 500) {
  const idle = () => window.formValues && window.calculationQueue
    && window.calculationQueue.length === 0 && !window.isCalculating;
  await page.waitForFunction(idle, null, { timeout: 60000 });
  await page.waitForTimeout(settleMs);
  await page.waitForFunction(idle, null, { timeout: 60000 });
}

/** Pola słownikowe i wpisywane: wartość w `values` kontra to, co widzi użytkownik. */
async function formMismatches(page, watch) {
  return page.evaluate((watchList) => {
    const out = [];
    for (const p of window.params || []) {
      const name = p.NAME;
      if (!name || name.startsWith('SUB___') || p.SCRIPTS !== '<NULL>' || p.FORMULA !== '<NULL>') continue;
      if (p.SOURCE === name || p.TYPE === 'file' || p.TYPE === 'link') continue;
      if (watchList.length && !watchList.includes(name)) continue;
      const input = window.formInputs?.[name];
      const holder = input?.parentNode;
      if (!input || !holder || getComputedStyle(holder).display === 'none') continue;
      const shown = String(input.value ?? '');
      const raw = window.formValues[name];
      const value = raw === undefined || raw === null ? '' : String(raw);
      const shownEmpty = shown === '' || shown === 'ffff' || shown === 'undefined';
      if (!shownEmpty && value === '') out.push(`${name}: formularz pokazuje "${shown}", a do zapisu idzie pusta wartość`);
      else if (shownEmpty && value !== '') out.push(`${name}: w danych "${value}", a pole wygląda na puste`);
      else if (!shownEmpty && shown !== value) out.push(`${name}: formularz "${shown}" ≠ dane "${value}"`);
    }
    return out;
  }, watch || []);
}

async function doStep(page, step) {
  if (step.type === 'fill') {
    // Jak człowiek: zaznacz, skasuj, pisz znak po znaku (zdarzenia `input` i debounce 500 ms).
    await page.click(`#${step.name}`, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    for (const ch of String(step.value)) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(step.delay ?? 60);
    }
  } else if (step.type === 'dialog') {
    await page.click(`#${step.name}`);
    await page.waitForSelector('#color-dialog[open]');
    await page.waitForTimeout(step.wait ?? 300);
    await page.locator(`#color-dialog .image-box:visible:has(.image-name[data-value="${step.value}"])`).first().click();
    await page.waitForFunction(() => !document.getElementById('color-dialog').open, null, { timeout: 15000 });
  } else if (step.type === 'select') {
    await page.selectOption(`#${step.name}`, String(step.value));
  } else if (step.type === 'wait') {
    await page.waitForTimeout(step.ms);
  } else {
    throw new Error(`nieznany krok ${step.type}`);
  }
}

/** Pułapka: stos wywołań przy kasowaniu opisu lub wartości wskazanego pola. */
async function installTrap(context, name) {
  await context.addInitScript((param) => {
    window.__copyTrap = [];
    const stack = () => new Error().stack.split('\n').slice(3, 9).join('\n');
    const wrap = (entry) => (entry && typeof entry === 'object' && !entry.__trapped ? new Proxy(entry, {
      get(t, k) { return k === '__trapped' ? true : t[k]; },
      deleteProperty(t, k) {
        if (k === 'option_value') window.__copyTrap.push(`usunięto opis.option_value (${JSON.stringify(t[k])})\n${stack()}`);
        delete t[k];
        return true;
      }
    }) : entry);
    const mapSet = Map.prototype.set;
    Map.prototype.set = function (k, v) { return mapSet.call(this, k, k === param ? wrap(v) : v); };
    const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      get() { return valueProp.get.call(this); },
      set(v) {
        if (this.id === param && (v === '' || String(v) === '0')) window.__copyTrap.push(`pole ← ${JSON.stringify(v)}\n${stack()}`);
        valueProp.set.call(this, v);
      }
    });
  }, name);
}

async function readTrap(page) {
  return page.evaluate(() => (window.__copyTrap || []).splice(0)).catch(() => []);
}

/** Definicje pól otwartego formularza — do klasyfikacji różnic (copyCompare.classifyKey). */
async function readFormMeta(page) {
  const meta = await page.evaluate(() => {
    const calculated = [];
    const price = [];
    for (const p of window.params || []) {
      if (!p || !p.NAME) continue;
      if (p.FORMULA !== '<NULL>' || p.SCRIPTS !== '<NULL>' || (p.SOURCE !== '<NULL>' && p.SOURCE !== p.NAME)) calculated.push(p.NAME);
      if (p.LISTROW === '2' || p.LISTSUM === 'true') price.push(p.NAME);
    }
    return { calculated, price };
  });
  return { calculated: new Set(meta.calculated), price: new Set(meta.price) };
}

/**
 * Pole do sprawdzenia walidacji: wybierane przez klienta (przycisk albo lista),
 * widoczne, wypełnione, pilnowane przez walidację zapisu (`inputFlags`).
 */
async function pickRequiredField(page, r) {
  return page.evaluate((rand) => {
    const list = [];
    for (const p of window.params || []) {
      const name = p && p.NAME;
      if (!name || name.startsWith('SUB___') || name === 'ILOSC') continue;
      if (p.FORMULA !== '<NULL>' || p.SCRIPTS !== '<NULL>' || p.SOURCE !== '<NULL>') continue;
      if ((p.REQUIRED ?? true) === false) continue;
      if (window.inputFlags && !(name in window.inputFlags)) continue;
      const input = window.formInputs?.[name];
      if (!input || !['BUTTON', 'SELECT'].includes(input.tagName)) continue;
      if (!input.parentNode || getComputedStyle(input.parentNode).display === 'none') continue;
      const v = window.formValues?.[name];
      if (v === undefined || v === null || v === '') continue;
      list.push(name);
    }
    return list.length ? list[Math.floor(rand * list.length)] : null;
  }, r);
}

// ── baza ───────────────────────────────────────────────────────────────────

async function readRow(conn, id) {
  const [[row]] = await conn.query('SELECT * FROM order_item WHERE id=?', [id]);
  return row || null;
}

async function maxPositionId(conn, orderId) {
  const [[row]] = await conn.query('SELECT COALESCE(MAX(id),0) id FROM order_item WHERE order_id=?', [orderId]);
  return row.id;
}

async function newestPositionId(conn, orderId, afterId) {
  const [[row]] = await conn.query('SELECT MAX(id) id FROM order_item WHERE order_id=? AND id>?', [orderId, afterId]);
  return row?.id || null;
}

const versionKey = (v) => String(v || '').split('.').map((n) => String(Number(n) || 0).padStart(6, '0')).join('.');

/**
 * Kandydaci na pozycje wzorcowe: prawdziwe pozycje grupy, bez powtórzeń
 * konfiguracji, najpierw z najnowszych wersji reguł. Pozycja sprzed dodania
 * nowego pola wymaganego (14.10: vertical #6472 bez PROTEKCJA) słusznie nie
 * przechodzi zapisu — byłaby pominięta, a noc przepadłaby na samych starych.
 */
async function loadCandidates(conn, group, orderId, rng, limit = 300) {
  const [rows] = await conn.query(
    'SELECT * FROM order_item WHERE asortment_group_number=? AND order_id<>? ORDER BY id DESC LIMIT ?',
    [group, orderId, limit]);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const v = parseJson(r.json_parameters);
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const signature = Object.keys(v)
      .filter((k) => !k.includes('___') && !k.endsWith('_ALIAS') && !k.startsWith('SUB___') && k !== 'uid'
        && !/^(CENA|DOPLATA|SUMA|WARTOSC|OPIS_)/.test(k))
      .sort().map((k) => `${k}=${v[k]}`).join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(r);
  }
  // Trzy przedziały: 5 najnowszych wersji, kolejne 15, reszta — losowo w każdym.
  const ranked = [...new Set(out.map((r) => versionKey(r.ver)))].sort().reverse();
  const tier = (r) => { const i = ranked.indexOf(versionKey(r.ver)); return i < 5 ? 0 : i < 20 ? 1 : 2; };
  return [0, 1, 2].flatMap((t) => shuffle(out.filter((r) => tier(r) === t), rng));
}

async function findScenarioBase(conn, scenario, orderId, baseId) {
  if (baseId) {
    const row = await readRow(conn, baseId);
    if (!row) throw new Error(`brak pozycji ${baseId}`);
    return row;
  }
  const [rows] = await conn.query(
    'SELECT * FROM order_item WHERE asortment_group_number=? AND order_id<>? ORDER BY id DESC LIMIT 400',
    [scenario.group, orderId]);
  const match = rows.find((r) => {
    const v = parseJson(r.json_parameters);
    return v && Object.entries(scenario.base).every(([k, want]) => v[k] === want);
  });
  if (!match) throw new Error(`grupa ${scenario.group}: brak pozycji z ${JSON.stringify(scenario.base)} — podaj --base=<id>`);
  return match;
}

/** Wartości i opisy pozycji bazowej po nadpisaniu pól scenariusza. */
function applyOverride(row, override) {
  const values = parseJson(row.json_parameters) || {};
  const display = new Map(parseJson(row.json_parameters_desc) || []);
  for (const [name, spec] of Object.entries(override || {})) {
    const [value, description] = Array.isArray(spec) ? spec : [spec, null];
    values[name] = value;
    if (description !== null) values[`${name}___DESCRIPTION`] = description;
    values[`${name}___VISIBLE`] = true;
    const entry = display.get(name) || { param_description: name, locked: false, sub: false, row: '1' };
    if (value === '') {
      delete entry.option_value;
      delete entry.option_description;
      values[`${name}___DESCRIPTION`] = '';
    } else {
      entry.option_value = String(value);
      entry.option_description = description ?? '';
    }
    display.set(name, entry);
  }
  return { values, displayEntries: Array.from(display.entries()) };
}

// ── kroki przypadku ────────────────────────────────────────────────────────

/** Zapis pozycji wzorcowej przez API (jak przy imporcie) w zleceniu symulatora. */
async function saveBaseViaApi(ctx, row, { values, displayEntries, version, lang }) {
  const marker = `COPYTEST-${Date.now() % 1e8}`;
  const saved = await ctx.page.evaluate(async ({ order, b, vals, desc, version, marker, lang }) => {
    const body = {
      order, listPrice: b.list_price, discountPercentage: 0, discount: 0, unitPrice: b.unit_price,
      totalPrice: b.total_price, totalPriceSub: b.total_price_sub, name: marker, commission: marker,
      jsonValues: vals, jsonValuesToDisplay: JSON.stringify(desc), amount: 1, comment: '',
      version, groupNumber: b.asortment_group_number, lang, department: b.department,
      group: b.group_name, parameters_short: b.parameters_short, total: {}
    };
    const fd = new FormData();
    fd.append('data', JSON.stringify(body));
    return (await fetch('/position/save', { method: 'POST', body: fd })).json();
  }, { order: ctx.orderId, b: row, vals: values, desc: displayEntries, version, marker, lang });
  if (saved.status !== 'success') throw new Error(`nie zapisano pozycji wzorcowej: ${JSON.stringify(saved).slice(0, 200)}`);
  const [[{ id }]] = await ctx.conn.query('SELECT MAX(id) id FROM order_item WHERE order_id=? AND commision=?', [ctx.orderId, marker]);
  if (!id) throw new Error('pozycja wzorcowa zapisana, ale nie ma jej w bazie');
  ctx.created.push(id);
  return id;
}

async function openEdit(ctx, id) {
  await ctx.page.goto(`${ctx.appUrl}/position/${id}/edit/`);
  await waitIdle(ctx.page, 1000);
}

/**
 * Klik „Zapisz" i rozpoznanie wyniku. Na stronie nowej pozycji przycisk działa
 * dopiero 10 s po zbudowaniu formularza (`loadedAt`).
 * @returns {Promise<{ok:boolean, newId?:number|null, invalid?:string[]}>}
 */
async function clickSave(ctx, { loadedAt = null } = {}) {
  const { page } = ctx;
  if (loadedAt) {
    const wait = SAVE_BUTTON_DELAY_MS - (Date.now() - loadedAt);
    if (wait > 0) await page.waitForTimeout(wait);
  }
  const before = await maxPositionId(ctx.conn, ctx.orderId);
  await page.click('#show-button');
  // `commit`: przekierowanie na zlecenie następuje dopiero po odpowiedzi zapisu,
  // więc pozycja już jest w bazie — nie czekamy na załadowanie całej strony zlecenia.
  const redirected = await page.waitForURL((u) => /^\/orders\/order\/\d+\/?$/.test(u.pathname), { timeout: 30000, waitUntil: 'commit' })
    .then(() => true).catch(() => false);
  if (!redirected) {
    const invalid = await page.evaluate(() => Array.from(document.querySelectorAll('.invalid-input')).map((e) => e.id)).catch(() => []);
    return { ok: false, invalid };
  }
  const newId = await newestPositionId(ctx.conn, ctx.orderId, before);
  if (newId) ctx.created.push(newId);
  return { ok: true, newId };
}

/**
 * Strona nowej pozycji → „wczytaj ostatnią konfigurację". `mutate` dostaje
 * `localStorage.formData` i może go zmienić (uszkodzony stan, puste pole).
 */
async function loadLastConfig(ctx, { department, group, corrupt = null, clear = null }) {
  const { page } = ctx;
  await page.evaluate(({ department, group, corrupt, clear }) => {
    localStorage.setItem('lastChoice', JSON.stringify({ department, group }));
    if (!corrupt?.length && !clear) return;
    const form = JSON.parse(localStorage.getItem('formData'));
    if (!form) return;
    const display = new Map(form.displayValues);
    for (const name of corrupt || []) {
      const e = display.get(name);
      if (e) { delete e.option_value; delete e.option_description; }
    }
    if (clear) {
      form.values[clear] = '';
      form.values[`${clear}___DESCRIPTION`] = '';
      const e = display.get(clear);
      if (e) { delete e.option_value; delete e.option_description; }
    }
    form.displayValues = Array.from(display.entries());
    localStorage.setItem('formData', JSON.stringify(form));
  }, { department: String(department), group: String(group), corrupt, clear });
  await page.goto(`${ctx.appUrl}/orders/order/${ctx.orderId}/new-position/`);
  await page.waitForSelector('#last-config-confirm', { state: 'visible', timeout: 30000 });
  await page.click('#last-config-confirm');
  await page.waitForFunction((g) => window.tempGroupNumber === g && window.editFlag === true
    && window.formInputs && (window.formInputs.ILOSC || Object.keys(window.formInputs).length > 3), String(group), { timeout: 60000 });
  // Licznik zapisu startuje po zbudowaniu formularza z konfiguracją.
  const loadedAt = Date.now();
  await waitIdle(page, 1000);
  return loadedAt;
}

async function duplicatePosition(ctx, id) {
  const dup = await ctx.page.evaluate(async (pid) => (await fetch(`/position/${pid}/duplicate/`, { method: 'POST' })).json(), id);
  const newId = +String(dup.redirect || '').match(/position\/(\d+)\//)?.[1];
  if (!newId) throw new Error(`„Duplikuj" się nie udał: ${JSON.stringify(dup).slice(0, 200)}`);
  ctx.created.push(newId);
  return newId;
}

/** `localStorage.formData` z prawdziwej pozycji — jakby klient skonfigurował ją przed chwilą. */
async function seedLastConfig(ctx, row) {
  await ctx.page.evaluate(({ values, displayValues }) => {
    localStorage.setItem('formData', JSON.stringify({ values, displayValues }));
  }, { values: parseJson(row.json_parameters) || {}, displayValues: parseJson(row.json_parameters_desc) || [] });
}

/** Jedna zmiana pola na stronie edycji wpisuje stan formularza do `localStorage.formData`. */
async function touchForLastConfig(ctx, values) {
  const hasQuantity = await ctx.page.evaluate(() => !!window.formInputs?.ILOSC && window.formInputs.ILOSC.tagName === 'INPUT');
  if (!hasQuantity) return false;
  await doStep(ctx.page, { type: 'fill', name: 'ILOSC', value: values.ILOSC || 1 });
  await waitIdle(ctx.page, 800);
  return true;
}

async function cleanup(ctx) {
  const ids = ctx.created.splice(0);
  if (!ids.length) return;
  if (ctx.keep) { ctx.print(`  pozostawione pozycje: ${ids.join(', ')}`); return; }
  for (const id of ids) {
    await ctx.page.evaluate(async (pid) => fetch(`/position/${pid}/delete`, { method: 'DELETE' }), id).catch(() => {});
  }
  const [[left]] = await ctx.conn.query(`SELECT COUNT(*) n FROM order_item WHERE id IN (${ids.map(Number).join(',')})`);
  if (left.n) ctx.print(`  ⚠ nie udało się usunąć ${left.n} z ${ids.length} pozycji: ${ids.join(', ')}`);
}

// ── przypadki ──────────────────────────────────────────────────────────────

/** Różnice zależne od środowiska (VAT_ENABLED), a nie od kopiowania — nie oblewają przypadku. */
const SYSTEMIC_KINDS = new Set(['ZMIANA_VAT_RABATU']);
const realProblems = (check) => check.problems.filter((p) => !SYSTEMIC_KINDS.has(p.kind));

function newCheck(pathKey, iteration = null) {
  return { path: pathKey, iteration, problems: [], positionId: null, differences: [] };
}

function addProblem(ctx, check, kind, text, { priority = null, fields = [] } = {}) {
  check.problems.push({ kind, priority: priority || EXTRA_PRIORITY[kind] || 'HIGH', text, fields });
  ctx.print(`    ✖ ${kind}: ${text}`);
}

function addDifferences(ctx, check, cmp) {
  check.differences = cmp.differences.slice(0, MAX_DIFFERENCES_KEPT);
  for (const s of summarizeDifferences(cmp.differences)) addProblem(ctx, check, s.kind, s.text, { priority: s.priority, fields: s.fields });
}

/**
 * Przypadek wygenerowany: prawdziwa pozycja jako wzorzec → kopie bez zmian
 * wszystkimi ścieżkami → porównanie pole po polu.
 */
async function runGeneratedCase(ctx, spec) {
  const res = {
    kind: 'generated', key: `grupa-${spec.group}`, group: spec.group, browser: ctx.browserName,
    sourceId: null, checks: [], status: 'ok', reason: '', fieldsCompared: 0, skippedBases: []
  };
  const started = Date.now();
  try {
    // 1. Wzorzec powstaje TAK JAK U KLIENTA: konfiguracja prawdziwej pozycji
    //    wczytana na stronie nowej pozycji na dzisiejszych regułach i zapisana.
    //    ⚠️ Nie przez stronę edycji: ta zachowuje stan zapisany w starej
    //    pozycji (14.10: vertical #6663 z 0.3.278 trzymał ILOSC_PASK, które
    //    w 0.3.318 ma ENABLE =1=2), a nowa pozycja liczy wszystko od nowa —
    //    porównanie wychodziło fałszywie „zgubione pole".
    let baseline = null;
    let baseId = null;
    let meta = null;
    let requiredField = null;
    for (const row of spec.candidates.slice(0, 3)) {
      await seedLastConfig(ctx, row);
      const loadedAt = await loadLastConfig(ctx, { department: spec.department, group: spec.group });
      const candidateMeta = await readFormMeta(ctx.page);
      const candidateRequired = spec.checkRequired ? await pickRequiredField(ctx.page, ctx.rng()) : null;
      const saved = await clickSave(ctx, { loadedAt });
      if (!saved.ok || !saved.newId) {
        res.skippedBases.push({ id: row.id, reason: `formularz odrzuca zapis na dzisiejszych regułach (${(saved.invalid || []).join(', ') || 'bez podświetlonych pól'})` });
        continue;
      }
      baseline = await readRow(ctx.conn, saved.newId);
      baseId = saved.newId;
      meta = candidateMeta;
      requiredField = candidateRequired;
      res.sourceId = row.id;
      break;
    }
    if (!baseline) {
      res.status = 'pominiety';
      res.reason = `żadna z ${Math.min(3, spec.candidates.length)} pozycji wzorcowych nie przechodzi zapisu na dzisiejszych regułach`;
      ctx.print(`  pominięty: ${res.reason}`);
      return res;
    }
    ctx.print(`  wzorzec: konfiguracja poz. ${res.sourceId} → zapisana jako ${baseId}`);

    // 2. „Wczytaj ostatnią konfigurację" — łańcuchowo, jak Ryver (kopia kopii).
    //    Stan bierze z `formData`, które strona nowej pozycji zapisała przy
    //    wczytaniu wzorca (main.js, buildDynamicForm). Najpierw ta ścieżka:
    //    otwarcie strony edycji czyści `formData` (generateForm).
    for (let it = 1; it <= spec.repeat; it++) {
      const check = newCheck('ostatnia', it);
      res.checks.push(check);
      const loadedAt = await loadLastConfig(ctx, { department: spec.department, group: spec.group });
      for (const m of await formMismatches(ctx.page, [])) addProblem(ctx, check, 'ROZJAZD_FORMULARZA', `po wczytaniu — ${m}`);
      for (const t of await readTrap(ctx.page)) ctx.print(`    ⚑ pułapka (kopia ${it}): ${t.replace(/\n/g, '\n        ')}`);
      const saved = await clickSave(ctx, { loadedAt });
      if (!saved.ok || !saved.newId) {
        addProblem(ctx, check, 'ZAPIS_ZABLOKOWANY', `kopii bez zmian nie da się zapisać — walidacja zatrzymała zapis na: ${(saved.invalid || []).join(', ') || '(brak podświetlonych pól)'}`);
        break;
      }
      check.positionId = saved.newId;
      const cmp = compareSavedPositions(baseline, await readRow(ctx.conn, saved.newId), { meta });
      res.fieldsCompared += cmp.compared;
      addDifferences(ctx, check, cmp);
    }

    // 3. Otwarcie zapisanego wzorca: formularz ma pokazać to, co zapisano,
    //    a zapis nie może zostawić opisów bez wartości.
    const open = newCheck('otwarcie');
    res.checks.push(open);
    open.positionId = baseId;
    for (const name of missingDescriptions(baseline, meta.calculated)) {
      addProblem(ctx, open, 'OPIS_BEZ_WARTOSCI', `${name}: nowa pozycja zapisana z opisem bez wartości (tabela/PDF: „-")`, { priority: 'P1', fields: [name] });
    }
    await openEdit(ctx, baseId);
    for (const m of await formMismatches(ctx.page, [])) addProblem(ctx, open, 'ROZJAZD_FORMULARZA', m);

    // 4. „Duplikuj": kopia w bazie 1:1, potem otwarcie i zapis bez zmian.
    const dupBase = newCheck('duplikat-baza');
    const dupId = await duplicatePosition(ctx, baseId);
    const rawCopy = await readRow(ctx.conn, dupId);
    const rawCmp = compareSavedPositions(baseline, rawCopy, { meta, compareComment: true });
    res.fieldsCompared += rawCmp.compared;
    addDifferences(ctx, dupBase, rawCmp);
    dupBase.positionId = dupId;
    res.checks.push(dupBase);

    const dup = newCheck('duplikat');
    res.checks.push(dup);
    await openEdit(ctx, dupId);
    for (const m of await formMismatches(ctx.page, [])) addProblem(ctx, dup, 'ROZJAZD_FORMULARZA', `po otwarciu kopii — ${m}`);
    const dupSaved = await clickSave(ctx);
    if (!dupSaved.ok) {
      addProblem(ctx, dup, 'ZAPIS_ZABLOKOWANY', `kopii bez zmian nie da się zapisać — walidacja zatrzymała zapis na: ${dupSaved.invalid.join(', ') || '(brak podświetlonych pól)'}`);
    } else {
      dup.positionId = dupId;
      const cmp = compareSavedPositions(baseline, await readRow(ctx.conn, dupId), { meta, compareComment: true });
      res.fieldsCompared += cmp.compared;
      addDifferences(ctx, dup, cmp);
    }

    // 5. Walidacja: ostatnia konfiguracja z pustym polem wymaganym nie może przejść.
    //    Stan wzorca zasiany od nowa — strona edycji (krok 3–4) wyczyściła `formData`.
    if (requiredField) {
      const check = newCheck('wymagane');
      check.field = requiredField;
      res.checks.push(check);
      let loadedAt;
      try {
        await seedLastConfig(ctx, baseline);
        loadedAt = await loadLastConfig(ctx, { department: spec.department, group: spec.group, clear: requiredField });
      } catch (err) {
        addProblem(ctx, check, 'BLAD_TESTU', `formularz z pustym ${requiredField} nie zbudował się / nie skończył przeliczać: ${err.message.split('\n')[0]}`, { fields: [requiredField] });
        return res;
      }
      const stillEmpty = await ctx.page.evaluate((n) => {
        const v = window.formValues?.[n];
        return v === undefined || v === null || v === '';
      }, requiredField);
      if (!stillEmpty) {
        check.notApplicable = `formularz sam uzupełnił ${requiredField}`;
        ctx.print(`  walidacja: ${check.notApplicable} — nie dotyczy`);
      } else {
        const saved = await clickSave(ctx, { loadedAt });
        if (saved.ok) {
          addProblem(ctx, check, 'ZAPIS_PRZESZEDL', `pozycja zapisała się z pustym polem wymaganym ${requiredField}`, { fields: [requiredField] });
          check.positionId = saved.newId;
        } else if (!saved.invalid.includes(requiredField)) {
          ctx.print(`  walidacja: zapis zablokowany, ale podświetlone ${saved.invalid.join(', ') || 'nic'} zamiast ${requiredField}`);
        } else {
          ctx.print(`  walidacja: zapis z pustym ${requiredField} zablokowany ✔`);
        }
      }
    }
  } catch (err) {
    res.status = 'blad';
    res.reason = err.message.split('\n')[0];
    ctx.print(`    ✖ BLAD_TESTU: ${res.reason}`);
  } finally {
    res.durationMs = Date.now() - started;
    if (res.status === 'ok' && res.checks.some((c) => realProblems(c).length)) res.status = 'bledy';
    await cleanup(ctx);
  }
  return res;
}

/** Scenariusz Ryver: kopia → kroki jak u klienta → zapis → pilnowane pola. */
async function runScenario(ctx, key, scenario, { repeat = null, baseId = null, departmentOf = () => null } = {}) {
  const res = {
    kind: 'scenario', key, opis: scenario.opis, group: scenario.group, browser: ctx.browserName,
    sourceId: null, checks: [], status: 'ok', reason: '', fieldsCompared: 0
  };
  const started = Date.now();
  const { page, conn } = ctx;
  const department = departmentOf(scenario.group) || scenario.department;
  const trapOut = async (label) => {
    for (const t of await readTrap(page)) ctx.print(`    ⚑ pułapka (${label}): ${t.replace(/\n/g, '\n        ')}`);
  };
  try {
    if (!department) throw new Error(`grupa ${scenario.group} niewidoczna dla konta symulatora`);
    // 1. Pozycja bazowa w aktualnej wersji reguł grupy.
    const baseRow = await findScenarioBase(conn, scenario, ctx.orderId, baseId);
    res.sourceId = baseRow.id;
    const version = await page.evaluate(async (g) => (await (await fetch(`/position/version/${g}/`)).json()).version, scenario.group);
    const { values, displayEntries } = applyOverride(baseRow, scenario.override);
    const savedId = await saveBaseViaApi(ctx, baseRow, { values, displayEntries, version, lang: scenario.lang || baseRow.lang || 'nl' });
    ctx.print(`  baza: poz. ${savedId} (z ${baseRow.id}, wersja ${version})`);

    // 2. „Ostatnia konfiguracja" bierze stan z ostatniego przeliczenia formularza —
    //    jedna zmiana na stronie edycji wpisuje go do localStorage.
    if (scenario.mode === 'ostatnia') {
      await openEdit(ctx, savedId);
      await touchForLastConfig(ctx, values);
      await trapOut('przygotowanie');
    }
    const baseline = parseJson((await readRow(conn, savedId)).json_parameters) || {};

    const total = repeat ?? scenario.repeat ?? 2;
    for (let it = 1; it <= total; it++) {
      ctx.print(`  kopia ${it}/${total}`);
      const check = newCheck(scenario.mode === 'ostatnia' ? 'ostatnia' : 'duplikat', it);
      res.checks.push(check);
      let positionId = null;
      let loadedAt = null;
      if (scenario.mode === 'ostatnia') {
        loadedAt = await loadLastConfig(ctx, { department, group: scenario.group, corrupt: scenario.corruptStorage });
      } else {
        positionId = await duplicatePosition(ctx, savedId);
        await openEdit(ctx, positionId);
      }
      for (const m of await formMismatches(page, scenario.watch)) addProblem(ctx, check, 'ROZJAZD_FORMULARZA', `po otwarciu kopii — ${m}`);

      for (const step of scenario.steps) await doStep(page, step);
      await waitIdle(page, 800);
      for (const m of await formMismatches(page, scenario.watch)) addProblem(ctx, check, 'ROZJAZD_FORMULARZA', `przed zapisem — ${m}`);
      await trapOut(`kopia ${it}`);

      const meta = await readFormMeta(page);
      const saved = await clickSave(ctx, { loadedAt });
      if (!saved.ok) {
        const expected = scenario.expectBlocked || [];
        if (expected.length && expected.every((n) => saved.invalid.includes(n))) {
          ctx.print(`    ✔ zapis zablokowany zgodnie z oczekiwaniem (${saved.invalid.join(', ')})`);
        } else {
          addProblem(ctx, check, 'ZAPIS_ZABLOKOWANY', `walidacja zatrzymała zapis na: ${saved.invalid.join(', ') || '(brak podświetlonych pól)'}`);
        }
        continue;
      }
      if (scenario.expectBlocked?.length) addProblem(ctx, check, 'ZAPIS_PRZESZEDL', `oczekiwano blokady na ${scenario.expectBlocked.join(', ')}`);

      if (scenario.mode === 'ostatnia') {
        positionId = saved.newId;
        if (!positionId) { addProblem(ctx, check, 'ZAPIS_ZABLOKOWANY', 'przekierowanie bez nowej pozycji w bazie'); continue; }
      }
      check.positionId = positionId;
      const row = await readRow(conn, positionId);
      const savedValues = parseJson(row.json_parameters) || {};
      const expectedChanges = scenario.expectChanged || [];
      for (const name of scenario.watch) {
        if (expectedChanges.includes(name)) continue;
        res.fieldsCompared += 1;
        if (String(savedValues[name] ?? '') !== String(baseline[name] ?? '')) {
          const kind = savedValues[name] === undefined || savedValues[name] === '' ? 'BRAK_POLA' : 'ZMIANA_WARTOSCI';
          addProblem(ctx, check, kind, `${name}: ${JSON.stringify(baseline[name])} → ${JSON.stringify(savedValues[name])}`, { priority: 'P1', fields: [name] });
        }
      }
      for (const name of missingDescriptions(row, meta.calculated)) {
        addProblem(ctx, check, 'OPIS_BEZ_WARTOSCI', `${name}="${savedValues[name]}" zapisane, ale tabela/PDF pokażą „-"`, { priority: 'P1', fields: [name] });
      }
      const changed = expectedChanges.filter((n) => String(savedValues[n] ?? '') !== String(baseline[n] ?? ''))
        .map((n) => `${n}=${JSON.stringify(savedValues[n])}`);
      ctx.print(`    zapisano poz. ${positionId}${changed.length ? ` (celowe zmiany: ${changed.join(', ')})` : ''}`);
    }
  } catch (err) {
    res.status = 'blad';
    res.reason = err.message.split('\n')[0];
    ctx.print(`    ✖ BLAD_TESTU: ${res.reason}`);
  } finally {
    res.durationMs = Date.now() - started;
    if (res.status === 'ok' && res.checks.some((c) => realProblems(c).length)) res.status = 'bledy';
    await cleanup(ctx);
  }
  return res;
}

// ── raport ─────────────────────────────────────────────────────────────────

/** Zgłoszenia w formacie raportu robota (reportBuilder / mailer). */
function caseFindings(res) {
  const date = new Date().toISOString();
  const where = res.kind === 'scenario'
    ? `scenariusz ${res.key}${res.sourceId ? ` (na wzór poz. #${res.sourceId})` : ''}`
    : `pozycja wzorcowa #${res.sourceId}`;
  const out = [];
  for (const check of res.checks) {
    for (const p of check.problems) {
      out.push({
        priority: p.priority,
        code: `KOPIA_${p.kind}`,
        groupNumber: res.group,
        positionId: res.sourceId ?? null,
        expected: `${check.path}${check.iteration ? `#${check.iteration}` : ''}|${res.browser}|${res.key}`,
        actual: (p.fields || []).join(', ') || p.text,
        message: `${BROWSER_LABEL[res.browser] || res.browser} · ${PATH_LABEL[check.path] || check.path}`
          + `${check.iteration > 1 ? ` (kopia ${check.iteration})` : ''} · ${where}: ${p.text}`,
        date,
        source: 'copy',
        copy: { browser: res.browser, path: check.path, iteration: check.iteration, scenario: res.kind === 'scenario' ? res.key : null, sourceId: res.sourceId }
      });
    }
  }
  if (res.status === 'blad') {
    out.push({
      priority: 'MEDIUM', code: 'KOPIA_BLAD_TESTU', groupNumber: res.group, positionId: res.sourceId ?? null,
      expected: `${res.browser}|${res.key}`, actual: res.reason,
      message: `${BROWSER_LABEL[res.browser] || res.browser} · ${where}: robot przerwał przypadek — ${res.reason}. To informacja o robocie, nie dowód błędu kopiowania.`,
      date, source: 'copy', copy: { browser: res.browser, scenario: res.kind === 'scenario' ? res.key : null, sourceId: res.sourceId }
    });
  }
  return out;
}

function summarize(cases, browsers) {
  const stats = {
    copyCases: 0, copyCasesFailed: 0, copyCasesSkipped: 0, copyCasesBroken: 0, copyChecks: 0, copyFieldsCompared: 0,
    copyScenarios: 0, copyGenerated: 0, byGroup: {}, byBrowser: {}, byPath: {}
  };
  for (const b of browsers) stats.byBrowser[b.name] = { label: BROWSER_LABEL[b.name] || b.name, skipped: b.skipped || null, cases: 0, checks: 0, failed: 0 };
  for (const c of cases) {
    if (c.status === 'pominiety') { stats.copyCasesSkipped += 1; continue; }
    stats.copyCases += 1;
    if (c.kind === 'scenario') stats.copyScenarios += 1; else stats.copyGenerated += 1;
    const failed = c.status === 'bledy';
    if (failed) stats.copyCasesFailed += 1;
    if (c.status === 'blad') stats.copyCasesBroken += 1;
    stats.copyFieldsCompared += c.fieldsCompared || 0;
    const checks = c.checks.filter((k) => !k.notApplicable).length;
    stats.copyChecks += checks;
    const g = stats.byGroup[c.group] || (stats.byGroup[c.group] = { cases: 0, checks: 0, failed: 0 });
    g.cases += 1; g.checks += checks; if (failed) g.failed += 1;
    const b = stats.byBrowser[c.browser] || (stats.byBrowser[c.browser] = { label: c.browser, cases: 0, checks: 0, failed: 0 });
    b.cases += 1; b.checks += checks; if (failed) b.failed += 1;
    for (const k of c.checks) {
      if (k.notApplicable) continue;
      const p = stats.byPath[k.path] || (stats.byPath[k.path] = { label: PATH_LABEL[k.path] || k.path, checks: 0, failed: 0 });
      p.checks += 1; if (realProblems(k).length) p.failed += 1;
    }
  }
  return stats;
}

/** Narastająco od pierwszego przebiegu — do raportu dla szefa. */
function appendHistory(stats, file) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { /* pierwszy wpis */ }
  if (!Array.isArray(history)) history = [];
  history.push({
    at: new Date().toISOString(), cases: stats.copyCases, failed: stats.copyCasesFailed, checks: stats.copyChecks,
    fields: stats.copyFieldsCompared, browsers: Object.keys(stats.byBrowser).filter((b) => !stats.byBrowser[b].skipped)
  });
  try { fs.writeFileSync(file, JSON.stringify(history, null, 1)); } catch (_e) { /* historia nie może przewrócić przebiegu */ }
  return {
    since: history[0].at,
    runs: history.length,
    cases: history.reduce((s, h) => s + (h.cases || 0), 0),
    checks: history.reduce((s, h) => s + (h.checks || 0), 0),
    failed: history.reduce((s, h) => s + (h.failed || 0), 0)
  };
}

// ── przebieg ───────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {string[]} [opts.browsers]   domyślnie CONFIGTEST_COPY_BROWSERS albo ['chromium']
 * @param {number}   [opts.cases]      przypadków wygenerowanych na przeglądarkę (CONFIGTEST_COPY_CASES, 24)
 * @param {number}   [opts.budgetMin]  limit czasu całości (CONFIGTEST_COPY_BUDGET_MIN, 50)
 * @param {boolean|string[]} [opts.scenarios] scenariusze Ryver: true = wszystkie, lista nazw, false = żadne
 * @param {string[]} [opts.groups]     ogranicz przypadki wygenerowane do tych grup
 * @param {number}   [opts.seed]       ziarno losowania wzorców (domyślnie data)
 * @param {number}   [opts.repeat]     ile kopii „ostatniej konfiguracji" z rzędu (2)
 * @param {function} [opts.print]      wyjście (domyślnie log robota)
 * @param {string}   [opts.historyFile] narastająca historia przebiegów (tylko przebieg nocny)
 * @returns {Promise<{findings:Array, stats:object, cases:Array, skipped:string|null}>}
 */
async function runCopyChecks(opts = {}) {
  const print = opts.print || ((s) => log(`ConfiguratorTester (kopiowanie): ${s}`));
  const appUrl = (opts.appUrl || appUrlFromEnv()).replace(/\/$/, '');
  const refused = refuseReason(appUrl);
  if (refused) return { findings: [], stats: summarize([], []), cases: [], skipped: refused };

  const orderId = process.env.CONFIGTEST_SIM_ORDER_ID;
  const browserNames = opts.browsers || listEnv(process.env.CONFIGTEST_COPY_BROWSERS, ['chromium']);
  const envCases = process.env.CONFIGTEST_COPY_CASES;
  const casesPerBrowser = opts.cases ?? (envCases && Number.isFinite(+envCases) ? +envCases : DEFAULT_CASES);
  const budgetMs = (opts.budgetMin ?? (Number(process.env.CONFIGTEST_COPY_BUDGET_MIN) || DEFAULT_BUDGET_MIN)) * 60000;
  const pauseMs = opts.pauseMs ?? (Number(process.env.CONFIGTEST_COPY_PAUSE_MS) || DEFAULT_PAUSE_MS);
  const priority = listEnv(process.env.CONFIGTEST_COPY_PRIORITY_GROUPS, DEFAULT_PRIORITY_GROUPS);
  const seed = opts.seed ?? seedFromDate();
  const scenarioNames = opts.scenarios === false ? []
    : Array.isArray(opts.scenarios) ? opts.scenarios : Object.keys(SCENARIOS);
  const minFreeMb = Number(process.env.CONFIGTEST_COPY_MIN_FREE_MB) || 700;

  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: process.env.DATABASE_PORT, user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE || 'eform'
  });

  const started = Date.now();
  const cases = [];
  const browsers = [];
  try {
    print(`start — ${appUrl}, zlecenie symulatora ${orderId}, przeglądarki: ${browserNames.join(', ')}, `
      + `${casesPerBrowser} przypadków + ${scenarioNames.length} scenariuszy na przeglądarkę, limit ${Math.round(budgetMs / 60000)} min, ziarno ${seed}`);

    for (let bi = 0; bi < browserNames.length; bi++) {
      const name = browserNames[bi];
      const entry = { name };
      browsers.push(entry);
      const free = require('./memoryGuard').hostAvailableMb();
      if (Number.isFinite(free) && free < minFreeMb) {
        entry.skipped = `za mało wolnej pamięci hosta (${free} MB < ${minFreeMb} MB)`;
        print(`${name}: pominięta — ${entry.skipped}`);
        continue;
      }
      let browser;
      try {
        browser = await launchBrowser(name, { headed: opts.headed });
      } catch (err) {
        entry.skipped = `nie uruchomiła się: ${err.message.split('\n')[0]}`;
        print(`${name}: pominięta — ${entry.skipped}`);
        continue;
      }
      // Każda przeglądarka dostaje równą część pozostałego czasu.
      const deadline = Date.now() + (budgetMs - (Date.now() - started)) / (browserNames.length - bi);
      const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
      if (opts.trap) await installTrap(context, opts.trap);
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      if (opts.slow && name !== 'firefox' && name !== 'webkit') {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: opts.slow, downloadThroughput: 400 * 1024, uploadThroughput: 200 * 1024 });
      }
      const ctx = {
        page, conn, appUrl, orderId, browserName: name, created: [], keep: !!opts.keep, print, rng: makeRng(seed)
      };
      try {
        await page.goto(`${appUrl}/user/auth/login?pin=${encodeURIComponent(process.env.CONFIGTEST_SIM_PIN)}&password=${encodeURIComponent(process.env.CONFIGTEST_SIM_PASSWORD)}`);
        const { discoverDepartmentsAndGroups } = require('./simulationRunner');
        const tree = await discoverDepartmentsAndGroups(page, { appUrl, orderId });
        const departmentByGroup = new Map();
        const groupNames = new Map();
        for (const d of tree) {
          for (const g of d.allGroups || d.groups) {
            if (!departmentByGroup.has(String(g.code))) departmentByGroup.set(String(g.code), d.num);
            if (!groupNames.has(String(g.code))) groupNames.set(String(g.code), g.name);
          }
        }
        const departmentOf = (g) => departmentByGroup.get(String(g)) || null;

        for (const key of scenarioNames) {
          if (Date.now() > deadline) { print('limit czasu — pozostałe scenariusze pominięte'); break; }
          const scenario = SCENARIOS[key];
          if (!scenario) { print(`nieznany scenariusz ${key}`); continue; }
          print(`\n▶ [${name}] ${key}: ${scenario.opis}`);
          const r = await runScenario(ctx, key, scenario, { repeat: opts.repeat, baseId: opts.base, departmentOf });
          r.groupName = groupNames.get(String(r.group)) || '';
          cases.push(r);
          await page.waitForTimeout(pauseMs);
        }

        const visible = [...departmentByGroup.keys()]
          .filter((g) => !opts.groups || opts.groups.map(String).includes(g));
        const plan = allocateCases(visible, casesPerBrowser, priority);
        const candidates = new Map();
        const used = new Map();
        for (let i = 0; i < plan.length; i++) {
          if (Date.now() > deadline) {
            print(`limit czasu — wykonano ${i} z ${plan.length} przypadków wygenerowanych`);
            entry.cut = plan.length - i;
            break;
          }
          const group = plan[i];
          if (!candidates.has(group)) {
            candidates.set(group, await loadCandidates(conn, group, orderId, ctx.rng));
          }
          const offset = used.get(group) || 0;
          const list = candidates.get(group).slice(offset);
          if (!list.length) continue;
          print(`\n▶ [${name}] przypadek ${i + 1}/${plan.length}: grupa ${group}${groupNames.get(group) ? ` (${groupNames.get(group)})` : ''}`);
          const r = await runGeneratedCase(ctx, {
            group, department: departmentOf(group), candidates: list,
            repeat: opts.repeat ?? 2, checkRequired: true
          });
          used.set(group, offset + 1 + r.skippedBases.length);
          r.groupName = groupNames.get(group) || '';
          cases.push(r);
          await page.waitForTimeout(pauseMs);
        }
      } catch (err) {
        entry.error = err.message.split('\n')[0];
        print(`${name}: przerwana — ${entry.error}`);
        await cleanup(ctx).catch(() => {});
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    await conn.end().catch(() => {});
  }

  const stats = summarize(cases, browsers);
  stats.durationMin = Math.round((Date.now() - started) / 6000) / 10;
  stats.appUrl = appUrl;
  stats.seed = seed;
  stats.browsersCut = browsers.filter((b) => b.cut).map((b) => ({ name: b.name, cut: b.cut }));
  stats.browserErrors = browsers.filter((b) => b.error).map((b) => ({ name: b.name, error: b.error }));
  if (opts.historyFile) stats.history = appendHistory(stats, opts.historyFile);
  const findings = collapseSystemic(cases.flatMap(caseFindings));
  for (const b of browsers.filter((x) => x.error)) {
    findings.push({
      priority: 'MEDIUM', code: 'KOPIA_BLAD_TESTU', groupNumber: null, positionId: null, expected: b.name, actual: b.error,
      message: `${BROWSER_LABEL[b.name] || b.name}: przebieg kopiowania przerwany — ${b.error}. Brak zgłoszeń z tej przeglądarki NIE oznacza, że kopiowanie działa.`,
      date: new Date().toISOString(), source: 'copy'
    });
  }
  print(`koniec: ${stats.copyCases} przypadków (${stats.copyCasesFailed} z błędami, ${stats.copyCasesSkipped} pominiętych), `
    + `${stats.copyChecks} kopii/kontroli, ${stats.copyFieldsCompared} porównań pól, ${stats.durationMin} min`);
  return { findings, stats, cases, skipped: null };
}

/**
 * Różnice systemowe — te same w każdym przypadku — jako JEDNO zgłoszenie
 * zbiorcze. 14.10: „Duplikuj → edycja → zapis" dopisuje VAT/brutto w każdej
 * grupie (strona edycji przelicza je od razu, edit_form.js
 * `applyVatToGrossValue`; nowa pozycja zapisana bez zmian ich nie ma) —
 * 24 jednakowe wpisy co noc zasłoniłyby prawdziwe błędy kopiowania.
 */
const SYSTEMIC_CODES = new Set(['KOPIA_ZMIANA_VAT_RABATU']);

function collapseSystemic(findings) {
  const out = [];
  const merged = new Map();
  for (const f of findings) {
    if (!SYSTEMIC_CODES.has(f.code)) { out.push(f); continue; }
    const key = `${f.code}|${f.copy?.path}|${f.copy?.browser}`;
    if (!merged.has(key)) merged.set(key, { first: f, groups: new Set(), sources: [] });
    const m = merged.get(key);
    m.groups.add(String(f.groupNumber));
    if (f.positionId != null) m.sources.push(f.positionId);
  }
  for (const { first, groups, sources } of merged.values()) {
    if (sources.length <= 1) { out.push(first); continue; }
    out.push(Object.assign({}, first, {
      groupNumber: null,
      positionId: null,
      actual: [...groups].join(', '),
      message: `${BROWSER_LABEL[first.copy?.browser] || first.copy?.browser} · ${PATH_LABEL[first.copy?.path] || first.copy?.path}: `
        + `w ${sources.length} przypadkach (grupy ${[...groups].join(', ')}; wzorce #${sources.slice(0, 8).join(', #')}${sources.length > 8 ? '…' : ''}) `
        + `ta sama różnica — ${first.message.split(': ').slice(1).join(': ')}. Zależy od VAT_ENABLED (produkcja: wyłączony); nie jest to utrata danych przy kopiowaniu.`
    }));
  }
  return out;
}

/** Plik historii przebiegów nocnych. */
function defaultHistoryFile() {
  return path.join(require('../../config').configTestOutputDir, 'kopiowanie-historia.json');
}

module.exports = {
  runCopyChecks,
  runGeneratedCase,
  runScenario,
  caseFindings,
  collapseSystemic,
  summarize,
  allocateCases,
  seedFromDate,
  refuseReason,
  defaultHistoryFile,
  SCENARIOS,
  PATH_LABEL,
  BROWSER_LABEL
};
