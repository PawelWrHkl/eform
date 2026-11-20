'use strict';

/**
 * KOSZTY TRANSPORTU na fakturach organizacja → klient (dziś Luxan GmbH): kalkulator
 * Wiktorii (KONTRAKT_TRANSPORT v3 z 19.11.2026), decyzje Pawła z 20.11.2026.
 *
 * Raz na ZAMKNIĘTY dzień wysyłki (dzień < dziś) idzie jedno zapytanie
 * `POST /v1/transport/quote` ze WSZYSTKIMI sztukami wysłanymi tego dnia klientom organizacji
 * z TRANSPORT_ORGS (status.txt: wiersz = sztuka, tylko `!sent!`), także tymi, które są już
 * na fakturze (`inv` = jej numer). Niezafakturowane dostają numer tymczasowy Z + id zlecenia:
 * API wskazuje fakturę z NAJNIŻSZYM numerem w przesyłce, porównując tekst, więc numer
 * tymczasowy musi sortować się za prawdziwymi (cyfry, „FV/…”).
 *
 * Faktura poziomu 2 zlecenia wysłanego od TRANSPORT_SINCE powstaje dopiero, gdy KAŻDY jego
 * dzień wysyłki ma odpowiedź 200; do tego czasu czeka (prośba Wiktorii). Dostaje linie opłat
 * przypisanych do numeru tymczasowego jej zleceń: tekst `text_de`, ilość 1, cena `amount`,
 * VAT jak towar (kontrakt pkt 4). Kwota 0 i PASS_THROUGH: nic. MONTHLY: raz na klienta
 * i miesiąc. Opłata przy fakturze już wystawionej: E-Form z linią tej przesyłki → pomijamy,
 * inna (PROD albo bez linii) i UNRESOLVED → mail „do biura”.
 *
 * Odpowiedź dnia jest zapamiętana w pliku stanu (katalog logów instancji, bez DDL). Nowe
 * zapytanie idzie tylko wtedy, gdy zmienią się pozycje dnia. Zmiana `inv` po wystawieniu
 * faktury go nie wywołuje, więc opłata zostaje przy numerze wskazanym za pierwszym razem.
 *
 * Błędy (Paweł 20.11): 400/413/422 i 401/403 → alarm od razu z listą `errors`, ponowienie co
 * godzinę; 500 → dwie ponowne próby co 5 min, potem alarm; 503, brak połączenia, timeout →
 * ponowienia po 1, 2, 5 i 10 min, potem co 15, alarm po 30 min. Między godzinnymi cyklami
 * faktur ponawia `scripts/transportQuoteRetry.js` (cron co minutę).
 *
 * .env: TRANSPORT_ENABLED=true, TRANSPORT_SINCE=RRRR-MM-DD (wymagane), TRANSPORT_API_URL,
 * TRANSPORT_ORGS (domyślnie LUXANGMBH), TRANSPORT_ALARM_TO, TRANSPORT_OFFICE_TO (domyślnie jak
 * alarm), TRANSPORT_STATE_FILE. Klucz TRANSPORT_API_KEY tylko w .env.local.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logsDir } = require('../../config');
const { STATUS_FILE, parseStatusFile, positionNumber } = require('../prodStatus');
const { mapOrderItemsToInvoiceItems } = require('./core/orderMapper');
const { toIsoDay, todayIso } = require('./core/dates');
const { log: defaultLog } = require('../../utils/logging');

const MIN = 60 * 1000;
const TEMP_PREFIX = 'Z';

function readTransportConfig(env = process.env) {
  const enabled = String(env.TRANSPORT_ENABLED || '').trim().toLowerCase() === 'true';
  const rawSince = String(env.TRANSPORT_SINCE || '').trim();
  const since = /^\d{4}-\d{2}-\d{2}$/.test(rawSince) && toIsoDay(new Date(`${rawSince}T12:00:00`)) === rawSince ? rawSince : null;
  const url = String(env.TRANSPORT_API_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.TRANSPORT_API_KEY || '').trim();
  const problems = [];
  if (enabled && !since) problems.push(`TRANSPORT_SINCE musi być datą RRRR-MM-DD (jest: „${rawSince}”)`);
  if (enabled && (!url || !key)) problems.push('brak TRANSPORT_API_URL albo TRANSPORT_API_KEY (klucz w .env.local)');
  const alarmTo = String(env.TRANSPORT_ALARM_TO || '').trim();
  return {
    enabled,
    since,
    url,
    key,
    problems,
    orgIdents: String(env.TRANSPORT_ORGS || 'LUXANGMBH').split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
    alarmTo,
    officeTo: String(env.TRANSPORT_OFFICE_TO || '').trim() || alarmTo,
    stateFile: env.TRANSPORT_STATE_FILE || path.join(logsDir, 'transport-quotes.json'),
    timeoutMs: 60 * 1000
  };
}

const tempInvoiceNo = (orderId) => `${TEMP_PREFIX}${String(orderId).padStart(8, '0')}`;
const isTempInvoiceNo = (inv) => typeof inv === 'string' && inv.startsWith(TEMP_PREFIX);
const orderKey = (userIdent, orderIdx) => `${String(userIdent || '').trim().toUpperCase()}|${String(orderIdx || '').trim()}`;
const deDay = (day) => day.split('-').reverse().join('.');

/** Nazwy krajów spotykane w adresach wysyłki (np. „SCHWEIZ”); nieznana idzie bez zmian i wraca w 422. */
const COUNTRY_NAMES = {
  DEUTSCHLAND: 'DE', GERMANY: 'DE', NIEMCY: 'DE', SCHWEIZ: 'CH', SWITZERLAND: 'CH', SZWAJCARIA: 'CH',
  OESTERREICH: 'AT', 'ÖSTERREICH': 'AT', AUSTRIA: 'AT', NIEDERLANDE: 'NL', NETHERLANDS: 'NL', HOLANDIA: 'NL',
  BELGIEN: 'BE', BELGIUM: 'BE', BELGIA: 'BE', LUXEMBURG: 'LU', LUXEMBOURG: 'LU', FRANKREICH: 'FR', FRANCE: 'FR',
  ITALIEN: 'IT', ITALY: 'IT', POLEN: 'PL', POLAND: 'PL', POLSKA: 'PL', DAENEMARK: 'DK', 'DÄNEMARK': 'DK', DENMARK: 'DK',
  TSCHECHIEN: 'CZ', CZECHY: 'CZ', UNGARN: 'HU', HUNGARY: 'HU', 'WĘGRY': 'HU', LIECHTENSTEIN: 'LI'
};
function isoCountry(value) {
  const raw = String(value || '').trim().toUpperCase();
  return raw.length === 2 ? raw : COUNTRY_NAMES[raw] || raw;
}

function isoDay(value) {
  const raw = String(value || '').trim();
  const de = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return de ? `${de[3]}-${de[2]}-${de[1]}` : toIsoDay(raw);
}

/** Rodzaj z pozycji zamówienia (Wiktoria 18.11); zastępczych E-Form nie ma, więc goods. */
function kindOf(name) {
  if (/schablone/i.test(name || '')) return 'template_pickup';
  if (/reparatur|naprawa/i.test(name || '')) return 'repair';
  return 'goods';
}

/**
 * Wysłane sztuki organizacji z status.txt. ORDERNO tylko z cyfr, jak w `prodStatus.diffStatuses`:
 * innych numerów E-Form nie zna jako swoich zleceń i ich nie fakturuje.
 */
function shippedPieces(fileRows, orgIdents) {
  const orgs = new Set(orgIdents);
  const pieces = [];
  for (const r of fileRows || []) {
    if (String(r.STATUS || '').trim() !== '!sent!') continue;
    if (!orgs.has(String(r.ORGANIZATIONIDENT || '').trim().toUpperCase())) continue;
    const orderIdx = String(r.ORDERNO || '').trim();
    const day = isoDay(r.SHIPPINGDATE);
    if (!/^\d+$/.test(orderIdx) || !day) continue;
    pieces.push({
      userIdent: String(r.USERIDENT || '').trim(),
      orderIdx,
      pos: positionNumber(r.ORDERPOS),
      day,
      // Słowo bez zmian (BUS, DBSCHENKER…), na kody kalkulatora zamienia usługa (Wiktoria 20.11)
      carrier: String(r.PARCELCODE || '').trim().split(/[\s,]+/)[0] || ''
    });
  }
  return pieces;
}

/**
 * Pozycje zapytania za dzień `day`.
 *
 * @param {Object} p
 * @param {string} p.day
 * @param {Array} p.pieces  `shippedPieces` (wszystkie dni: z wcześniejszych wynika `continuation`)
 * @param {Map<string, object>} p.orders  `orderKey` → zlecenie z `repository.getTransportOrders`
 * @param {Map<string, object>} p.items   `${orderId}|${pozycja}` → `{ id, name, netMinor, pieces }`
 * @param {Map<number, string>} p.issued  `order_item.id` → numer wystawionej faktury poziomu 2
 * @returns {{ positions: object[], skipped: number }}
 */
function buildDayPositions({ day, pieces, orders, items, issued }) {
  const groups = new Map();
  let skipped = 0;
  for (const p of pieces) {
    if (p.day !== day) continue;
    const order = orders.get(orderKey(p.userIdent, p.orderIdx));
    const item = order && items.get(`${order.id}|${p.pos}`);
    if (!item) { skipped++; continue; }
    const k = `${item.id}|${p.carrier}`;
    if (!groups.has(k)) groups.set(k, { order, item, pos: p.pos, carrier: p.carrier, qty: 0 });
    groups.get(k).qty++;
  }
  const earlier = new Set(pieces.filter((p) => p.day < day).map((p) => orderKey(p.userIdent, p.orderIdx)));
  const positions = [...groups.values()]
    .sort((a, b) => a.order.id - b.order.id || a.pos - b.pos || a.carrier.localeCompare(b.carrier))
    .map(({ order, item, carrier, qty }) => ({
      inv: issued.get(item.id) || tempInvoiceNo(order.id),
      order: String(order.commision || '').trim() || String(order.order_idx),
      orderno: `EO/${order.order_idx}`,
      client: String(order.paymaster_ident || '').trim() || order.user_ident,
      country: isoCountry(order.country),
      // „CH-9545”, „D-50667”: kalkulator czyta strefy z samego kodu
      zip: String(order.zip || '').trim().replace(/^[A-Z]{1,3}-(?=\d)/i, ''),
      address: order.address_key || '',
      ship_date: day,
      carrier,
      kind: kindOf(item.name),
      qty,
      // Sztuki pozycji wysłane w różne dni: wartość dzielona proporcjonalnie
      net: Math.round(item.netMinor * Math.min(qty, item.pieces) / item.pieces) / 100,
      continuation: earlier.has(orderKey(order.user_ident, order.order_idx))
    }));
  return { positions, skipped };
}

/** Odcisk pozycji dnia bez `inv`: wystawienie faktury nie zmienia przesyłki, więc nie wymusza nowej wyceny. */
function positionsHash(positions) {
  const body = JSON.stringify(positions.map(({ inv, ...rest }) => rest));
  return crypto.createHash('sha256').update(body).digest('hex');
}

const chargeKey = (day, charge) => `${day}|${[...(charge.orders || [])].map(String).sort().join(',')}`;
const amountOf = (charge) => (charge.amount === null || charge.amount === undefined ? 0 : Number(charge.amount));
const billable = (charge) => (charge.status === 'OK' || charge.status === 'MONTHLY') && amountOf(charge) > 0;

/** Klient opłaty MONTHLY: z pozycji dnia, których `order` jest w opłacie. */
function monthlyKey(day, charge, positions) {
  const orders = new Set((charge.orders || []).map(String));
  const pos = (positions || []).find((p) => orders.has(String(p.order)));
  return `${pos ? pos.client : '?'}|${day.slice(0, 7)}`;
}

/**
 * Linie transportu dla faktury zleceń `orderIds`.
 *
 * @param {Object} p
 * @param {number[]} p.orderIds
 * @param {Array<{ day: string, response: object, positions: object[] }>} p.days  odpowiedzi 200 dni wysyłki tych zleceń
 * @param {{ keys: Set<string>, monthly: Set<string> }} p.existing  linie transportu na wystawionych fakturach
 * @param {Set<string>} [p.taken]  klucze dodane już w tym przebiegu
 */
function linesForOrders({ orderIds, days, existing, taken = new Set() }) {
  const temps = new Set(orderIds.map(tempInvoiceNo));
  const lines = [];
  for (const { day, response, positions } of days) {
    for (const c of response.charges || []) {
      if (!temps.has(c.invoice) || !billable(c)) continue;
      const key = chargeKey(day, c);
      const monthly = c.status === 'MONTHLY' ? monthlyKey(day, c, positions) : null;
      if (existing.keys.has(key) || taken.has(key) || (monthly && (existing.monthly.has(monthly) || taken.has(`M|${monthly}`)))) continue;
      taken.add(key);
      if (monthly) taken.add(`M|${monthly}`);
      lines.push({
        name: c.text_de || `Transportkosten Sendung ${deDay(day)}`,
        netAmount: amountOf(c),
        quantity: 1,
        taxAsGoods: true,
        meta: {
          transport: {
            key, day, status: c.status, rule: c.rule || null, amount: c.amount,
            orders: c.orders || [], invoices: c.invoices || [], rulesVersion: response.rules_version || null,
            ...(monthly ? { monthly } : {})
          }
        }
      });
    }
  }
  return lines;
}

/**
 * Opłaty dnia dla biura: wskazana faktura już wystawiona (PROD albo E-Form bez linii tej
 * przesyłki) oraz UNRESOLVED (reguły nie znalazły kwoty).
 */
function officeItems({ day, response, positions, existing }) {
  const items = [];
  for (const c of response.charges || []) {
    if (c.status === 'UNRESOLVED') { items.push({ reason: 'brak kwoty (UNRESOLVED)', charge: c }); continue; }
    if (!billable(c) || isTempInvoiceNo(c.invoice)) continue;
    const orders = (c.orders || []).map(String);
    const hasLine = (existing.byNumber.get(String(c.invoice)) || []).some((l) => l.day === day && l.orders.some((o) => orders.includes(o)));
    if (hasLine) continue;
    if (c.status === 'MONTHLY' && existing.monthly.has(monthlyKey(day, c, positions))) continue;
    items.push({ reason: `faktura ${c.invoice} już wystawiona`, charge: c });
  }
  return items;
}

/** 400/413/422 i inne kody, których ponowienie nie naprawi → 'request'; 401/403 → 'auth'. */
function classifyFailure(http) {
  if ([401, 403].includes(http)) return 'auth';
  if (http === 500) return 'server';
  if ([0, 502, 503, 504].includes(http)) return 'transient';
  return 'request';
}

/**
 * Następna próba i alarm po nieudanym zapytaniu (Paweł 20.11).
 *
 * @param {object|null} prev  poprzednia porażka tego samego zapytania
 * @param {{ http: number, now: number }} p
 */
function planRetry(prev, { http, now }) {
  const kind = classifyFailure(http);
  const same = prev && prev.kind === kind;
  const count = (same ? prev.count : 0) + 1;
  const firstAt = same ? prev.firstAt : now;
  let delayMin;
  let alarm;
  if (kind === 'request' || kind === 'auth') { delayMin = 60; alarm = true; }
  else if (kind === 'server') { delayMin = count <= 2 ? 5 : 15; alarm = count >= 3; }
  else { delayMin = [1, 2, 5, 10][count - 1] || 15; alarm = now - firstAt >= 30 * MIN; }
  return { kind, http, count, firstAt, nextAt: now + delayMin * MIN, alarm, alarmedAt: same ? prev.alarmedAt || null : null };
}

/** Plik stanu: zapis przez plik tymczasowy, żeby przerwany zapis nie zostawił połowy JSON-a. */
function fileStore(file) {
  return {
    read() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
        if (err.code === 'ENOENT') return { days: {} };
        throw new Error(`plik stanu transportu ${file}: ${err.message}`);
      }
    },
    update(fn) {
      const state = this.read();
      fn(state);
      // Dni starsze niż 120 dni nie wrócą do żadnej faktury
      const oldest = toIsoDay(new Date(Date.now() - 120 * 24 * 60 * MIN));
      for (const day of Object.keys(state.days)) if (day < oldest) delete state.days[day];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
      fs.renameSync(`${file}.tmp`, file);
      return state;
    }
  };
}

let mailTransporter = null;
async function defaultSendMail({ to, subject, text }) {
  if (!mailTransporter) {
    mailTransporter = require('nodemailer').createTransport({
      host: 'serwer2560216.home.pl', port: 587, secure: false,
      auth: { user: process.env.MAILBOT_USER, pass: process.env.MAILBOT_PASSWORD },
      tls: { rejectUnauthorized: false }
    });
  }
  await mailTransporter.sendMail({ from: process.env.MAILBOT_USER, to, subject, text });
}

const KIND_LABEL = {
  request: 'zapytanie odrzucone',
  auth: 'klucz albo adres IP odrzucony',
  server: 'błąd kalkulatora',
  transient: 'kalkulator nie odpowiada'
};

/**
 * Przebieg transportu: jedna sesja na przebieg automatu faktur albo skryptu ponowień
 * (wspólny odczyt status.txt i linii z bazy, każdy dzień liczony raz).
 */
function createTransportSession({ config, repository, log = defaultLog, now = () => new Date(), fetchImpl = fetch, sendMail = defaultSendMail, store, readStatusFile } = {}) {
  const cfg = config || { enabled: false };
  const st = store || (cfg.enabled ? fileStore(cfg.stateFile) : null);
  const readFile = readStatusFile || (() => fs.promises.readFile(STATUS_FILE, 'utf8'));
  const days = new Map();
  const taken = new Set();
  let piecesPromise = null;
  let existingPromise = null;
  const envLabel = process.env.NODE_ENV || 'dev';

  const pieces = () => (piecesPromise ||= readFile().then((text) => shippedPieces(parseStatusFile(text), cfg.orgIdents)));

  const existing = () => (existingPromise ||= repository.findTransportLines().then((rows) => {
    const keys = new Set();
    const monthly = new Set();
    const byNumber = new Map();
    for (const r of rows) {
      const t = (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta || {}).transport || {};
      if (t.key) keys.add(t.key);
      if (t.monthly) monthly.add(t.monthly);
      if (!byNumber.has(r.number)) byNumber.set(r.number, []);
      byNumber.get(r.number).push({ day: t.day, orders: (t.orders || []).map(String) });
    }
    return { keys, monthly, byNumber };
  }));

  async function buildDayRequest(day) {
    const all = await pieces();
    const ofDay = all.filter((p) => p.day === day);
    if (!ofDay.length) return { positions: [], skipped: 0 };
    const pairs = [...new Map(ofDay.map((p) => [orderKey(p.userIdent, p.orderIdx), [p.userIdent, p.orderIdx]])).values()];
    const orderRows = await repository.getTransportOrders({ pairs });
    const orders = new Map(orderRows.filter((o) => cfg.orgIdents.includes(String(o.org_ident).toUpperCase()))
      .map((o) => [orderKey(o.user_ident, o.order_idx), o]));
    const itemRows = orders.size ? await repository.getTransportItems([...orders.values()].map((o) => o.id)) : [];
    const items = new Map();
    const byOrder = new Map();
    for (const it of itemRows) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
    const resolveTax = () => ({ taxRate: 0, taxCategory: 'standard' });
    for (const [orderId, list] of byOrder) {
      list.sort((a, b) => a.id - b.id);
      // Kwota jak na fakturze organizacja → klient (warstwa SUB, `core/orderMapper.js`)
      const mapped = mapOrderItemsToInvoiceItems({ orderItems: list, resolveTax, useSubPrices: true });
      list.forEach((it, index) => {
        items.set(`${orderId}|${Number(it.orderpos) || index + 1}`, {
          id: it.id, name: it.name, netMinor: mapped[index].unitPriceNetMinor, pieces: Math.max(1, Number(mapped[index].meta.pieces) || 1)
        });
      });
    }
    const issuedRows = items.size ? await repository.findIssuedTransportInvoices([...items.values()].map((i) => i.id)) : [];
    const issued = new Map(issuedRows.map((r) => [Number(r.order_item_id), String(r.number)]));
    return buildDayPositions({ day, pieces: all, orders, items, issued });
  }

  async function callQuote(positions) {
    try {
      const res = await fetchImpl(`${cfg.url}/v1/transport/quote`, {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
        signal: AbortSignal.timeout(cfg.timeoutMs)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* treść nie-JSON trafia do alarmu jako tekst */ }
      if (res.status === 200 && json && Array.isArray(json.charges)) return { ok: true, http: 200, json };
      const errors = json && (json.errors || json.detail || json.error);
      // 200 bez listy opłat traktujemy jak awarię kalkulatora (500), a nie jak „brak transportu”
      return { ok: false, http: res.status === 200 ? 500 : res.status, errors: [].concat(errors || text.slice(0, 500)) };
    } catch (err) {
      return { ok: false, http: 0, errors: [err && err.name === 'TimeoutError' ? `timeout ${cfg.timeoutMs / 1000} s` : `brak połączenia: ${err.message}`] };
    }
  }

  async function mail(to, subject, lines) {
    if (!to) { log(`[transport] brak adresata (TRANSPORT_ALARM_TO) — ${subject}`); return; }
    try {
      await sendMail({ to, subject, text: lines.join('\n') });
      log(`[transport] mail do ${to}: ${subject}`);
    } catch (err) {
      log(`[transport] mail do ${to} NIE wyszedł (${subject}): ${err.message}`);
    }
  }

  async function alarm(day, failure, req) {
    const at = new Date(failure.nextAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
    await mail(cfg.alarmTo, `[E-Form ${envLabel}] Transport ${deDay(day)}: ${KIND_LABEL[failure.kind]} (HTTP ${failure.http || 'brak'})`, [
      `Dzień wysyłki: ${deDay(day)}`,
      `Zapytanie: ${req.positions.length} pozycji (sztuki bez zlecenia E-Form pominięte: ${req.skipped}), ${cfg.url}/v1/transport/quote`,
      `Odpowiedź: HTTP ${failure.http || 'brak (połączenie / timeout)'}, próba ${failure.count}`,
      '',
      'Błędy:',
      ...(failure.errors || []).slice(0, 50).map((e) => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`),
      '',
      `Faktury organizacja → klient zleceń wysłanych tego dnia czekają. Następna próba: ${at}.`
    ]);
  }

  async function notifyOffice(day, entry) {
    const items = officeItems({ day, response: entry.response, positions: entry.positions, existing: await existing() });
    if (!items.length) return;
    await mail(cfg.officeTo, `[E-Form ${envLabel}] Transport ${deDay(day)}: do doliczenia przez biuro (${items.length})`, [
      `Kalkulator przypisał te opłaty do faktur już wystawionych albo nie znalazł kwoty. E-Form ich nie dopisał.`,
      `Propozycja: biuro dolicza je fakturą in blanco (szablon „Transport”) albo korektą wskazanej faktury.`,
      '',
      ...items.map(({ reason, charge: c }) => `- ${reason}: ${c.amount ?? '—'} EUR, ${c.status}, reguła ${c.rule || '—'}, zlecenia ${(c.orders || []).join(', ')}, faktury ${(c.invoices || []).join(', ')}${c.text_de ? `, „${c.text_de}”` : ''}${c.note ? ` (${c.note})` : ''}`)
    ]);
  }

  async function quoteDay(day) {
    const req = await buildDayRequest(day);
    const hash = positionsHash(req.positions);
    const prev = st.read().days[day];
    if (prev && prev.hash === hash && prev.response) return { ok: true, response: prev.response, positions: prev.positions };
    const t = now().getTime();
    if (!req.positions.length) {
      st.update((s) => { s.days[day] = { hash, positions: [], skipped: req.skipped, response: { charges: [] }, quotedAt: new Date(t).toISOString() }; });
      return { ok: true, response: { charges: [] }, positions: [] };
    }
    const prevFailure = prev && prev.hash === hash ? prev.failure : null;
    if (prevFailure && t < prevFailure.nextAt) {
      return { ok: false, reason: `${KIND_LABEL[prevFailure.kind]} (HTTP ${prevFailure.http || 'brak'}), następna próba ${new Date(prevFailure.nextAt).toISOString()}` };
    }
    const res = await callQuote(req.positions);
    if (res.ok) {
      const entry = { hash, positions: req.positions, skipped: req.skipped, response: res.json, quotedAt: new Date(t).toISOString() };
      st.update((s) => { s.days[day] = entry; });
      log(`[transport] ${day}: ${req.positions.length} pozycji, opłat ${res.json.charges.length}, reguły ${res.json.rules_version}`);
      await notifyOffice(day, entry);
      return { ok: true, response: res.json, positions: req.positions };
    }
    const failure = { ...planRetry(prevFailure, { http: res.http, now: t }), errors: res.errors };
    log(`[transport] ${day}: HTTP ${res.http || 'brak'} (${failure.kind}, próba ${failure.count}): ${(res.errors || []).slice(0, 5).join('; ')}`);
    if (failure.alarm && !failure.alarmedAt) {
      await alarm(day, failure, req);
      failure.alarmedAt = t;
    }
    st.update((s) => { s.days[day] = { hash, positions: req.positions, skipped: req.skipped, failure }; });
    return { ok: false, reason: `${KIND_LABEL[failure.kind]} (HTTP ${res.http || 'brak'})` };
  }

  /** Dzień wysyłki: odpowiedź 200 albo powód czekania (każdy dzień raz na sesję). */
  function ensureDay(day) {
    if (!days.has(day)) days.set(day, quoteDay(day));
    return days.get(day);
  }

  return {
    config: cfg,
    ensureDay,

    /**
     * Bramka i linie dla faktury zleceń `orderIds` (jedno zlecenie albo faktura zbiorcza).
     *
     * @returns {Promise<{ wait: boolean, reason?: string, serviceItems: object[] }>}
     */
    async forOrders(orderIds) {
      const none = { wait: false, serviceItems: [] };
      if (!cfg.enabled) return none;
      const mine = (await repository.getTransportOrders({ orderIds }))
        .filter((o) => cfg.orgIdents.includes(String(o.org_ident).toUpperCase()));
      if (!mine.length) return none;
      if (cfg.problems.length) return { wait: true, reason: `konfiguracja transportu: ${cfg.problems.join('; ')}`, serviceItems: [] };
      const keys = new Set(mine.map((o) => orderKey(o.user_ident, o.order_idx)));
      const shipDays = [...new Set((await pieces())
        .filter((p) => p.day >= cfg.since && keys.has(orderKey(p.userIdent, p.orderIdx))).map((p) => p.day))].sort();
      const today = todayIso(now());
      const open = shipDays.find((d) => d >= today);
      if (open) return { wait: true, reason: `dzień wysyłki ${open} jeszcze się nie zamknął`, serviceItems: [] };
      const quoted = [];
      for (const day of shipDays) {
        const r = await ensureDay(day);
        if (!r.ok) return { wait: true, reason: `transport ${day}: ${r.reason}`, serviceItems: [] };
        quoted.push({ day, response: r.response, positions: r.positions });
      }
      return { wait: false, serviceItems: linesForOrders({ orderIds: mine.map((o) => Number(o.id)), days: quoted, existing: await existing(), taken }) };
    },

    /** Dni z porażką, których kolejna próba już minęła (`scripts/transportQuoteRetry.js`). */
    dueDays() {
      if (!st) return [];
      const t = now().getTime();
      return Object.entries(st.read().days || {})
        .filter(([, d]) => d.failure && d.failure.nextAt <= t).map(([day]) => day).sort();
    }
  };
}

module.exports = {
  readTransportConfig,
  createTransportSession,
  tempInvoiceNo,
  isTempInvoiceNo,
  shippedPieces,
  buildDayPositions,
  positionsHash,
  linesForOrders,
  officeItems,
  planRetry,
  classifyFailure,
  kindOf,
  isoCountry,
  fileStore
};
