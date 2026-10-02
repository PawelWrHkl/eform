'use strict';

/**
 * Szablon dokumentu per organizacja — czyje i który plik.
 *
 * Gdzie w bazie: `invoice_organization_profile.template_code` → wiersz
 * `invoice_template`:
 *   - `background_file` — FORMATKA organizacji: PDF z papierem firmowym
 *     (`img/invoice-background/`, np. `LUXANGMBH.pdf`), na który nakładana
 *     jest treść faktury; rozmiar i orientacja strony biorą się z formatki,
 *   - `page_margins` — gdzie na formatce zostaje miejsce na treść (mm),
 *   - `template_file`/`stylesheet` — układ treści (Nunjucks/CSS), domyślnie wspólny.
 * Przypisanie robi `scripts/setInvoiceTemplate.js` (sprawdza, że plik istnieje).
 * Dokument zapisuje KOD szablonu przy tworzeniu (`invoice.template_code`): nowa
 * formatka (np. ze zmienionym kontem w stopce) to NOWY kod, a wystawione
 * faktury renderują się dalej na swojej.
 *
 * ⚠️ Szablon należy do WYSTAWCY, nie do organizacji zamówienia. Na poziomie 1
 * zamówienie jest organizacji-nabywcy (np. Luxan), a fakturę wystawia HKL —
 * wybór po `order.organization_id` drukowałby fakturę HKL w szablonie Luxanu.
 *
 * Czysta logika bez I/O — sprawdzanie istnienia pliku robi `render/renderer.js`.
 */

const path = require('path');
const { InvoiceLevel } = require('./hierarchy');

const DEFAULT_TEMPLATE_CODE = 'default';

/**
 * Marginesy treści na formatce, gdy szablon ich nie podaje (mm). Formatki mają
 * pasy nagłówka i stopki — bez marginesów treść weszłaby pod logo i dane firmy.
 */
const DEFAULT_BACKGROUND_MARGINS = Object.freeze({ top: 25, right: 12, bottom: 28, left: 12 });
/** Górna granica jednego marginesu — literówka (np. 250 zamiast 25) nie może zjeść strony. */
const MAX_MARGIN_MM = 120;

/** To, co renderer bierze, gdy wskazany szablon jest nieużywalny. */
const DEFAULT_TEMPLATE = Object.freeze({
  code: DEFAULT_TEMPLATE_CODE,
  templateFile: 'invoice-main.njk',
  stylesheet: 'styles/invoice.css',
  themeVars: {}
});

/**
 * `page_margins` z bazy (JSON `{"top":24,"right":12,"bottom":27,"left":12}`, mm)
 * → komplet marginesów. Brakujące albo błędne pola biorą wartość domyślną.
 *
 * @param {unknown} value obiekt, string JSON albo nic
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
function parsePageMargins(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const out = { ...DEFAULT_BACKGROUND_MARGINS };
  if (!raw || typeof raw !== 'object') return out;
  for (const side of Object.keys(out)) {
    const mm = Number(raw[side]);
    if (Number.isFinite(mm) && mm >= 0 && mm <= MAX_MARGIN_MM) out[side] = mm;
  }
  return out;
}

/**
 * Organizacja, której szablon obowiązuje na danym poziomie.
 *
 * @param {{ level: number, orderOrganizationId: number, manufacturerOrganizationId: number }} params
 * @returns {number|null} `null` → szablon domyślny (salon nie jest organizacją)
 */
function templateOrganizationId({ level, orderOrganizationId, manufacturerOrganizationId }) {
  switch (Number(level)) {
    case InvoiceLevel.MANUFACTURER_TO_ORGANIZATION:
      return Number(manufacturerOrganizationId) || null;
    case InvoiceLevel.ORGANIZATION_TO_USER:
    case InvoiceLevel.ORGANIZATION_TO_END_CLIENT:
      return Number(orderOrganizationId) || null;
    // Poziom 3: wystawcą jest salon (użytkownik). Szablon organizacji niesie jej
    // markę, a salon wystawia dokument we własnym imieniu — zostaje domyślny,
    // chyba że jego profil wystawcy wskazuje inny.
    default:
      return null;
  }
}

/**
 * Pierwszy kod różny od domyślnego.
 *
 * ⚠️ `'default'` traktujemy jak „nie ustawiono": kolumny `template_code` mają
 * `DEFAULT 'default'`, więc sam wiersz profilu wystawcy (np. dodany dla innego
 * pola) zasłaniałby szablon organizacji, gdyby wygrywała pierwsza niepusta wartość.
 *
 * @param {...(string|null|undefined)} candidates od najważniejszego
 * @returns {string}
 */
function pickTemplateCode(...candidates) {
  for (const candidate of candidates) {
    const code = String(candidate ?? '').trim();
    if (code && code !== DEFAULT_TEMPLATE_CODE) return code;
  }
  return DEFAULT_TEMPLATE_CODE;
}

/**
 * Ścieżka pliku szablonu z bazy → bezpieczna ścieżka względna albo `null`.
 *
 * Wartość przychodzi z bazy i trafia do loadera plików, więc odrzucamy
 * wszystko, co mogłoby wyjść poza katalog szablonów: ścieżki bezwzględne,
 * `..`, ukośniki wsteczne, znak NUL i inne rozszerzenia niż oczekiwane.
 *
 * @param {string} value          np. `invoice-main.njk`, `LUXANGMBH.pdf`
 * @param {string} extension      `.njk`, `.css` albo `.pdf`
 * @returns {string|null}
 */
function normalizeTemplatePath(value, extension) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.includes('\0') || raw.includes('\\') || path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) return null;
  if (!/^[A-Za-z0-9_\-./]+$/.test(normalized)) return null;
  if (path.posix.extname(normalized).toLowerCase() !== extension) return null;
  return normalized;
}

module.exports = {
  DEFAULT_TEMPLATE_CODE,
  DEFAULT_TEMPLATE,
  DEFAULT_BACKGROUND_MARGINS,
  parsePageMargins,
  templateOrganizationId,
  pickTemplateCode,
  normalizeTemplatePath
};
