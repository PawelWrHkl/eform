'use strict';

/**
 * PDF cennika klienta: lista grup do panelu, widok (dane do szablonu
 * `templates/pricelists/pdf.njk`), render Chromium i cache na dysku.
 *
 * Teksty interfejsu są w szablonie (`__()` z jezyki.xlsx); tu wyłącznie dane:
 * kwoty z `buildPricelist`, opisy opcji i parametrów z paramdict/param.txt
 * w języku konta. Czynników cenowych (litery wariantu, mnożniki, podwyżki) nie
 * ma w widoku: klient widzi wyłącznie kwoty.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../../config');
const { dataDir } = config;
const { selectQuery } = require('../../db/core');
const { listGroups, resolveGroupTerms } = require('../orgCustomers/groupTerms');
const { currencySymbol } = require('../currency');
const { log } = require('../../utils/logging');
const pricelists = require('./index');
const { shopPriceSet, shopPricelist, shopHasFinalPrices } = require('./shop');

const CACHE_DIR = path.join(config.rootDir, 'pricelists');
const CACHE_DAYS = 7;
const LOCALES = { pl: 'pl-PL', de: 'de-DE', nl: 'nl-NL', en: 'en-GB', fr: 'fr-FR' };
// Pliki, od których zależy wygląd i kwoty PDF-u: ich zmiana unieważnia cache.
const CODE_FILES = ['index.js', 'scriptModel.js', 'conditions.js', 'pdf.js', 'shop.js'].map((f) => path.join(__dirname, f))
  .concat(path.join(__dirname, '..', '..', 'templates', 'pricelists', 'pdf.njk'));

/** Konto, którego cennik liczymy (uid, skrypty, nagłówek PDF). */
async function loadAccount(userId) {
  const rows = await selectQuery(
    `SELECT u.id, u.ident, u.client_name, u.currency, u.organization_id AS orgId,
            o.ident AS org, o.photo_path
       FROM user u JOIN organization o ON o.id = u.organization_id
      WHERE u.id = ? LIMIT 1`,
    [userId]
  );
  return rows && rows[0] ? rows[0] : null;
}

/** Rabat klienta z nazw skryptów `*_RABAT` (generator zapisuje stałą w nazwie). */
function hasRebate(scripts, priceSet) {
  const prefix = priceSet === 'SUB' ? 'SUB___' : '';
  return Object.entries(scripts).some(([param, file]) => {
    if (!param.startsWith(prefix) || (!prefix && param.startsWith('SUB___')) || !/RABAT$/.test(param)) return false;
    const m = /-(\d+(?:\.\d+)?)\.js$/.exec(file || '');
    return !!m && Number(m[1]) > 0;
  });
}

/**
 * Grupy, do których konto ma dostęp i przypisany skrypt ceny — do listy w panelu.
 * `shop` (konto podrzędne grupy, `loadShopPricing`): skrypty grupy-matki w zestawie
 * konfiguratora konta, a drugi PDF, gdy cena końcowa konta różni się od katalogowej.
 */
async function listForAccount(account, priceSet, lang = 'pl', shop = null) {
  const set = shop ? shopPriceSet(shop) : priceSet;
  const out = [];
  for (const group of listGroups(lang)) {
    const terms = await resolveGroupTerms({ userId: account.id, groupNumber: group.groupNumber, orgIdent: account.org, userIdent: account.ident });
    const priceParam = set === 'SUB' ? 'SUB___CENA' : 'CENA';
    if (!terms.hasAccess || !terms.scripts[priceParam]) continue;
    const rebate = hasRebate(terms.scripts, set);
    out.push({ groupNumber: group.groupNumber, description: group.description, hasRebate: shop ? shopHasFinalPrices(shop, rebate) : rebate });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Widok

function formatter(lang, decimals) {
  return new Intl.NumberFormat(LOCALES[lang] || 'pl-PL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Etykieta parametru z param.txt bez jednostki w nawiasie („SZEROKOŚĆ [MM]” → „SZEROKOŚĆ”). */
function paramLabel(params, name) {
  const p = params[name];
  const text = p && p.DESCRIPTION && p.DESCRIPTION !== '<NULL>' ? p.DESCRIPTION : name;
  return text.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();
}

function optionLabel(options, param, value) {
  const o = (options[param] || []).find((x) => x.VALUE === value);
  return o && o.DESCRIPTION && o.DESCRIPTION !== value ? `${value} – ${o.DESCRIPTION}` : value;
}

const OPS = { '<=': '≤', '>=': '≥', '<': '<', '>': '>', '=': '=', '<>': '≠' };
const MAX_LISTED = 12;

/** Warunek pozycji/tabeli jako tekst: „Sterowanie: DHG – …, DHSV – …”, „Szerokość ≤ 1300 mm”. */
function filterText(filter, { params, options }) {
  if (filter.raw) return null;
  if (filter.compare) return `${paramLabel(params, filter.param)} ${OPS[filter.op] || filter.op} ${filter.value} mm`;
  const values = filter.options.slice(0, MAX_LISTED).map((v) => optionLabel(options, filter.param, v));
  const more = filter.options.length > MAX_LISTED ? ` … (+${filter.options.length - MAX_LISTED})` : '';
  return { label: paramLabel(params, filter.param), negated: !!filter.negated, values: values.join(', ') + more };
}

/** Nagłówek progu: „do 120 cm”, przy siatce punkt „150 cm”, przy osi-liczniku sama liczba (TORY 3). */
function boundHead(value, { count, grid }) {
  if (value === null) return null;
  return { value, upTo: !count && !grid, cm: !count };
}

/** Przypis do osi-wzoru (14: tabela w wymiarze paska, VERTI = wymiar całkowity − 3,8 cm). */
function variantNotes(table, { params, options, lang }) {
  const fmt = formatter(lang, 1);
  return (table.axisVariants || []).map((a) => ({
    field: paramLabel(params, a.field),
    base: optionLabel(options, a.base.param, a.base.value),
    others: a.others.map((v) => ({ variant: optionLabel(options, v.param, v.value), cm: fmt.format(Math.abs(v.shiftMm) / 10), less: v.shiftMm > 0 }))
  }));
}

/** Wysokości w wierszach, szerokości × grupy cenowe w kolumnach, bloki szerokości pod A4. */
function tableView(table, { params, options, lang }) {
  const amounts = Object.values(table.cells).flatMap((row) => Object.values(row));
  const fmt = formatter(lang, amounts.every((a) => Number.isInteger(a)) ? 0 : 2);
  const groups = table.priceGroups.map((token) => ({ token, label: token === null ? '' : String(token) }));
  const grid = !!table.gridStep;
  // Obie osie wyłączone (73: KARNISZ przy KAR) — jedna kwota niezależna od wymiarów.
  if (!table.xField && !table.yField && groups.length === 1) {
    const amount = (table.cells[groups[0].token] || {})['null|null'];
    if (amount !== undefined) {
      const domainLabels = table.options.map((o) => optionLabel(options, table.domainParam, o.value)).filter(Boolean);
      const filters = table.otherFilters.map((f) => filterText({ ...f, negated: false }, { params, options })).filter(Boolean);
      return { title: domainLabels.length ? domainLabels.join(', ') : filters.map((f) => `${f.label}: ${f.values}`).join(' · '), filters: domainLabels.length ? filters : [], single: fmt.format(amount), chunks: [], variants: [] };
    }
  }
  // Kwoty z groszami są szersze: mniej kolumn na blok, żeby tabela zmieściła się na A4 poziomo.
  const maxPerChunk = Math.max(1, Math.floor((amounts.every((a) => Number.isInteger(a)) ? 26 : 20) / groups.length));
  // Bloki równej szerokości (21 kolumn → 11 + 10, nie 20 + 1).
  const perChunk = Math.ceil(table.widths.length / Math.max(1, Math.ceil(table.widths.length / maxPerChunk)));
  const chunks = [];
  for (let i = 0; i < table.widths.length; i += perChunk) {
    const widths = table.widths.slice(i, i + perChunk);
    chunks.push({
      widths,
      heads: widths.map((w) => boundHead(w, { count: table.xCount, grid })),
      rows: table.heights.map((h) => ({
        height: h,
        head: boundHead(h, { count: table.yCount, grid }),
        cells: widths.flatMap((w) => groups.map((g) => {
          const amount = (table.cells[g.token] || {})[`${w}|${h}`];
          return amount === undefined ? null : fmt.format(amount);
        }))
      }))
    });
  }
  // Bez domeny (np. 46: KONFIGURACJA=S_N) nagłówkiem tabeli są jej filtry.
  const domainLabels = table.options.map((o) => optionLabel(options, table.domainParam, o.value)).filter(Boolean);
  const filters = table.otherFilters.map((f) => filterText({ ...f, negated: false }, { params, options })).filter(Boolean);
  return {
    title: domainLabels.length ? domainLabels.join(', ') : filters.map((f) => `${f.label}: ${f.values}`).join(' · '),
    filters: domainLabels.length ? filters : [],
    doubleFabric: table.doubleFabric,
    groups,
    showGroups: !(groups.length === 1 && groups[0].token === null),
    xLabel: table.xField ? paramLabel(params, table.xField) : null,
    yLabel: table.yField ? paramLabel(params, table.yField) : null,
    variants: variantNotes(table, { params, options, lang }),
    chunks
  };
}

/** Wzór z param.txt słowami: identyfikatory → opisy parametrów, `*` → `×`. */
function formulaWords(formula, params) {
  return String(formula).replace(/^=/, '')
    .replace(/[A-Z_][A-Z0-9_]*/g, (id) => (params[id] ? paramLabel(params, id) : id))
    .replace(/\*/g, ' × ').replace(/\+/g, ' + ').replace(/\s+/g, ' ').trim();
}

/** Przewodnik „szerokość tkaniny” (73) w języku konta. */
function guideView(guide, { params, options, lang }) {
  if (!guide) return null;
  const fmt = formatter(lang, Number.isInteger(guide.addCm) ? 0 : 1);
  return {
    addCm: fmt.format(guide.addCm),
    flatLabel: paramLabel(params, guide.flatParam),
    models: guide.models.map((m) => ({
      label: optionLabel(options, 'MODEL', m.value),
      rows: m.rows.map((r) => ({ label: optionLabel(options, r.param, r.value), percent: r.percent })),
      flat: m.flat.length ? m.flat.join(', ') : null,
      formula: m.formulaParam && params[m.formulaParam] ? formulaWords(params[m.formulaParam].FORMULA, params) : null
    }))
  };
}

function itemView(item, { params, options, lang }) {
  const fmt = formatter(lang, 2);
  const when = item.filters.map((f) => filterText(f, { params, options })).filter(Boolean);
  if (item.kind === 'amount') return { code: item.name, when, amounts: [{ amount: fmt.format(item.amount) }] };
  if (item.kind === 'byOption') {
    return {
      code: item.name,
      when,
      amounts: item.byOption.filter((b) => b.amount).map((b) => ({
        options: item.byOption.length > 1 ? b.options.slice(0, 6).join(', ') + (b.options.length > 6 ? ' …' : '') : null,
        amount: fmt.format(b.amount)
      }))
    };
  }
  if (item.kind === 'percentOf') return { code: item.name, when, percent: fmt.format(item.percent), ofParam: paramLabel(params, item.ofParam) };
  if (item.kind === 'perMeter') return { code: item.name, when, perMeter: fmt.format(item.perMeter), ofParam: paramLabel(params, item.ofParam) };
  return { code: item.name, when, configurator: true };
}

/**
 * Dane do szablonu PDF. `list` = wynik `buildPricelist` (albo `applyDiscount`).
 */
function buildView({ list, account, lang, groupDescription, vat, date, shop = null }) {
  const params = pricelists.readParams(list.groupNumber, list.version, lang);
  const options = pricelists.readOptions(list.groupNumber, list.version, lang);
  const ctx = { params, options, lang };
  // Konto podrzędne grupy dostaje ceny klienta (łańcuch SUB___), także przy narzucie od cen zwykłych.
  const shownSet = shop ? 'SUB' : list.priceSet;
  const logoFile = shownSet === 'SUB' ? account.photo_path : 'hkl.png';
  const logoPath = path.join(__dirname, '..', '..', 'img', logoFile || 'hkl.png');
  const parts = list.parts.filter((p) => p.tables || p.items).map((part) => {
    const base = part.param.replace(/^SUB___/, '');
    return {
      kind: base,
      label: paramLabel(params, part.param),
      tables: (part.tables || []).filter((t) => t.widths.length || t.heights.length).map((t) => tableView(t, ctx)),
      items: (part.items || []).filter((it) => it.kind !== 'dimensional' && !it.zero && it.amount !== null).map((it) => itemView(it, ctx)),
      missing: !!(part.missing || part.unparsed)
    };
  });
  return {
    lang,
    groupNumber: list.groupNumber,
    groupDescription,
    clientName: shop ? shop.name || shop.ident : account.client_name || account.ident,
    clientIdent: shop ? shop.ident : account.ident,
    dateText: date.toLocaleDateString(LOCALES[lang] || 'pl-PL'),
    priceSet: shownSet,
    discounted: !!list.discounted,
    currency: currencySymbol(account.currency),
    vatRate: shownSet === 'CENA' && vat && vat.vatRate !== null && vat.vatRate !== undefined ? vat.vatRate : null,
    logo: fs.existsSync(logoPath) ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}` : null,
    guide: guideView(list.guide, ctx),
    gridStep: list.parts.flatMap((p) => p.tables || []).map((t) => t.gridStep).find(Boolean) || null,
    parts
  };
}

// ---------------------------------------------------------------------------
// Cache i PDF

function cacheKey(parts) {
  const stamp = (file) => {
    try {
      const s = fs.statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return 'brak';
    }
  };
  return crypto.createHash('sha1').update(JSON.stringify({ ...parts, code: CODE_FILES.map(stamp) })).digest('hex');
}

function pruneCache() {
  try {
    const limit = Date.now() - CACHE_DAYS * 86400000;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p);
    }
  } catch (err) {
    log('[pricelists] sprzątanie cache:', err.message);
  }
}

async function htmlToPdf(html) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}

/**
 * PDF cennika jednej grupy. Kwoty liczone raz na kombinację (wersja grupy,
 * pliki skryptów, uid, dzień, język, rodzaj) — kolejne pobrania idą z dysku.
 *
 * @param {object} opts
 * @param {object} opts.account          wiersz z `loadAccount`
 * @param {'CENA'|'SUB'} opts.priceSet
 * @param {string} opts.groupNumber
 * @param {boolean} opts.discounted
 * @param {string} opts.lang
 * @param {(view:object)=>Promise<string>} opts.renderHtml   render szablonu (res.render)
 * @param {(account:object)=>Promise<object>} [opts.resolveVat]
 * @returns {Promise<{ok:true, pdf:Buffer, fileName:string}|{ok:false, status:number, reason:string}>}
 */
async function getPricelistPdf({ account, priceSet: requestedSet, groupNumber, discounted, lang, renderHtml, resolveVat, date = new Date(), shop = null }) {
  const priceSet = shop ? shopPriceSet(shop) : requestedSet;
  const terms = await resolveGroupTerms({ userId: account.id, groupNumber, orgIdent: account.org, userIdent: account.ident });
  if (!terms.hasAccess) return { ok: false, status: 404, reason: 'brak dostępu do grupy' };
  const version = await pricelists.activeVersion(groupNumber);
  if (!version) return { ok: false, status: 404, reason: 'brak wersji grupy' };

  const scriptsDir = path.join(dataDir, String(groupNumber), 'data');
  const key = cacheKey({
    groupNumber: String(groupNumber), version, priceSet, discounted: !!discounted, lang,
    account: [account.id, account.ident, account.client_name, account.currency],
    shop: shop && [shop.id, shop.ident, shop.name, shop.mode, shop.markupPercent, shop.clientPct, shop.bonusPct],
    day: date.toISOString().slice(0, 10),
    scripts: Object.entries(terms.scripts).sort().map(([p, f]) => {
      try {
        const s = fs.statSync(path.join(scriptsDir, f));
        return [p, f, s.mtimeMs, s.size];
      } catch {
        return [p, f, null];
      }
    })
  });
  const groupDescription = (listGroups(lang).find((g) => g.groupNumber === String(groupNumber)) || {}).description || '';
  const fileName = `${shop ? `${shop.ident}-` : ''}${groupDescription || groupNumber}${discounted ? '-rabat' : ''}-${date.toISOString().slice(0, 10)}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '_');
  const cached = path.join(CACHE_DIR, `${key}.pdf`);
  if (fs.existsSync(cached)) return { ok: true, pdf: fs.readFileSync(cached), fileName };

  let list = await pricelists.buildPricelist({ groupNumber, user: { id: account.id, ident: account.ident }, orgIdent: account.org, priceSet, lang, date, version });
  if (!list.ok) return { ok: false, status: 404, reason: list.reason };
  // Np. grupa 76: każdy skrypt z błędem składni — konfigurator też nic nie wyceni.
  if (list.parts.every((p) => p.missing || p.unparsed)) return { ok: false, status: 404, reason: 'żaden skrypt cenowy grupy nie daje się policzyć' };
  if (shop) {
    list = shopPricelist(list, shop, !!discounted);
  } else if (discounted) {
    list = pricelists.applyDiscount(list);
    if (!list) return { ok: false, status: 404, reason: 'grupa nie ma wzoru ceny po rabacie' };
  }
  const vat = !shop && priceSet === 'CENA' && resolveVat ? await resolveVat(account) : null;
  const html = await renderHtml(buildView({ list, account, lang, groupDescription, vat, date, shop }));
  const pdf = await htmlToPdf(html);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, pdf);
  pruneCache();
  return { ok: true, pdf, fileName };
}

module.exports = { loadAccount, listForAccount, getPricelistPdf, buildView, hasRebate, CACHE_DIR };
