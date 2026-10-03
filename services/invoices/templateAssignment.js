'use strict';

/**
 * Przypisanie formatki (papieru firmowego) organizacji — jedna ścieżka dla
 * panelu `/invoices/profile` i dla `scripts/setInvoiceTemplate.js`.
 *
 * Zapis: wiersz `invoice_template` (formatka + marginesy + układ treści) i jego
 * kod w `invoice_organization_profile.template_code`.
 *
 * ⚠️ WERSJONOWANIE: faktura zapamiętuje kod szablonu z chwili wystawienia
 * (`invoice.template_code`) i przy każdym wydruku renderuje się na formatce
 * spod tego kodu. Zmiana formatki W MIEJSCU przestawiłaby więc także
 * wystawione faktury — np. na stopkę z nowym numerem konta. Dlatego gdy obecny
 * kod ma już dokumenty, powstaje nowy kod (`LUXANGMBH_202610021015`), a stary
 * zostaje nietknięty. Dopóki kod nie ma dokumentów (strojenie marginesów przed
 * pierwszą fakturą), zmiany idą w miejsce.
 */

const fs = require('fs');
const path = require('path');
const defaultRepository = require('./db/repository');
const { BACKGROUNDS_DIR, TEMPLATES_DIR } = require('./render/renderer');
const { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_CODE, normalizeTemplatePath, parsePageMargins } = require('./core/templates');

/**
 * Plik wskazany przez użytkownika → ścieżka względna; brak/niedozwolony → błąd
 * z listą dostępnych plików (to komunikat dla człowieka w panelu albo konsoli).
 *
 * @param {string} baseDir
 * @param {string} value
 * @param {string} extension
 * @param {string} label
 * @param {(abs: string) => boolean} exists
 * @returns {string}
 */
function requireAsset(baseDir, value, extension, label, exists) {
  const rel = normalizeTemplatePath(value, extension);
  const abs = rel ? path.resolve(baseDir, rel) : null;
  if (!abs || !abs.startsWith(baseDir + path.sep)) throw new Error(`${label}: niedozwolona nazwa „${value}"`);
  if (!exists(abs)) {
    const available = fs.existsSync(baseDir) ? fs.readdirSync(baseDir).filter((f) => f.endsWith(extension)).join(', ') : '';
    throw new Error(`${label}: brak pliku ${rel} w ${baseDir}${available ? ` (dostępne: ${available})` : ''}`);
  }
  return rel;
}

/** Ident organizacji → bazowy kod szablonu (A–Z, 0–9, _, -). */
function baseCodeFor(orgCode, organizationId) {
  const code = String(orgCode || '').toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (code || `ORG${organizationId}`).slice(0, 40);
}

/** `LUXANGMBH` + chwila → `LUXANGMBH_202610021015` (czas lokalny serwera). */
function versionedCode(base, now) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}_${stamp}`;
}

function sameSettings(row, wanted) {
  if (!row) return false;
  const a = parsePageMargins(row.pageMargins);
  const b = wanted.pageMargins;
  return row.backgroundFile === wanted.backgroundFile
    && row.templateFile === wanted.templateFile
    && row.stylesheet === wanted.stylesheet
    && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * @param {Object} params
 * @param {number} params.organizationId
 * @param {string|null} params.backgroundFile  nazwa w `img/invoice-background/`; pusta = bez formatki
 * @param {Object} [params.pageMargins]        `{ top, right, bottom, left }` w mm
 * @param {string} [params.templateFile]       układ treści (domyślnie wspólny `invoice-main.njk`)
 * @param {string} [params.stylesheet]
 * @param {string} [params.code]               jawny kod (skrypt `--code`) — bez automatycznej wersji
 * @param {string} [params.name]               nazwa widoczna w panelu
 * @param {Object} [deps]                      `{ repository, exists, now }` — podmiana w testach
 * @returns {Promise<{ code: string, changed: boolean, versioned: boolean, previousCode: string }>}
 */
async function assignOrganizationTemplate(params, deps = {}) {
  const repository = deps.repository || defaultRepository;
  const exists = deps.exists || fs.existsSync;
  const now = deps.now || (() => new Date());
  const { organizationId } = params;

  const org = await repository.getOrganizationProfile(organizationId);
  if (!org) throw new Error(`Nie ma organizacji ${organizationId}`);
  const previousCode = org.templateCode || DEFAULT_TEMPLATE_CODE;

  // Bez formatki = szablon domyślny. Wiersz formatki zostaje — mogą go mieć wystawione faktury.
  if (!params.backgroundFile) {
    if (previousCode === DEFAULT_TEMPLATE_CODE) return { code: DEFAULT_TEMPLATE_CODE, changed: false, versioned: false, previousCode };
    if (!(await repository.upsertOrganizationProfile(organizationId, { template_code: DEFAULT_TEMPLATE_CODE }))) {
      throw new Error('Nie udało się zapisać profilu organizacji');
    }
    return { code: DEFAULT_TEMPLATE_CODE, changed: true, versioned: false, previousCode };
  }

  // Walidacja PRZED jakimkolwiek zapisem
  const wanted = {
    backgroundFile: requireAsset(BACKGROUNDS_DIR, params.backgroundFile, '.pdf', 'Formatka', exists),
    templateFile: requireAsset(TEMPLATES_DIR, params.templateFile || DEFAULT_TEMPLATE.templateFile, '.njk', 'Szablon treści', exists),
    stylesheet: requireAsset(TEMPLATES_DIR, params.stylesheet || DEFAULT_TEMPLATE.stylesheet, '.css', 'Arkusz stylów', exists),
    pageMargins: parsePageMargins(params.pageMargins)
  };
  if (params.code !== undefined && !/^[A-Z0-9_-]{1,60}$/.test(String(params.code))) {
    throw new Error(`Kod szablonu: dozwolone A–Z, 0–9, _ i -, maks. 60 znaków (jest „${params.code}")`);
  }

  const base = baseCodeFor(org.orgCode, organizationId);
  const current = previousCode !== DEFAULT_TEMPLATE_CODE ? await repository.getTemplateRow(previousCode) : null;
  if (!params.code && sameSettings(current, wanted)) {
    return { code: current.code, changed: false, versioned: false, previousCode };
  }

  // Edytujemy w miejscu tylko WŁASNY szablon organizacji (`IDENT` albo `IDENT_…`);
  // cudzy kod przypisany skryptem zostaje nietknięty — inaczej zmiana tutaj
  // przestawiłaby formatkę innej organizacji.
  const ownCode = current && (current.code === base || current.code.startsWith(`${base}_`));
  let code = params.code || (ownCode ? current.code : base);
  let versioned = false;
  if (!params.code && (await repository.countInvoicesWithTemplate(code)) > 0) {
    code = versionedCode(base, now());
    versioned = true;
  }

  await repository.upsertTemplate({
    code,
    name: params.name || `${org.seller && org.seller.name ? org.seller.name : base} · ${wanted.backgroundFile}`,
    templateFile: wanted.templateFile,
    stylesheet: wanted.stylesheet,
    backgroundFile: wanted.backgroundFile,
    pageMargins: wanted.pageMargins
  });
  if (!(await repository.upsertOrganizationProfile(organizationId, { template_code: code }))) {
    throw new Error('Nie udało się zapisać profilu organizacji');
  }
  return { code, changed: true, versioned, previousCode };
}

/**
 * Formatki dostępne do wyboru w panelu — pliki PDF z `img/invoice-background/`
 * z rozmiarem strony (pionowa formatka przy poziomej fakturze to ważna informacja).
 *
 * @returns {Promise<Array<{ file: string, widthMm: number|null, heightMm: number|null, orientation: string }>>}
 */
async function listBackgrounds() {
  const { backgroundPageSize } = require('./render/renderer');
  if (!fs.existsSync(BACKGROUNDS_DIR)) return [];
  const files = fs.readdirSync(BACKGROUNDS_DIR).filter((f) => normalizeTemplatePath(f, '.pdf')).sort();
  return Promise.all(files.map(async (file) => {
    try {
      const { widthMm, heightMm } = await backgroundPageSize(fs.readFileSync(path.join(BACKGROUNDS_DIR, file)));
      return { file, widthMm: Math.round(widthMm), heightMm: Math.round(heightMm), orientation: widthMm >= heightMm ? 'landscape' : 'portrait' };
    } catch {
      // Uszkodzony PDF — pokazujemy, ale bez wymiarów (renderer i tak go odrzuci)
      return { file, widthMm: null, heightMm: null, orientation: 'unknown' };
    }
  }));
}

module.exports = { assignOrganizationTemplate, listBackgrounds, baseCodeFor, versionedCode };
