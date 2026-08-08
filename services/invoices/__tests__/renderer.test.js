'use strict';

/**
 * Testy renderowania: kontekst → HTML. Bez Playwrighta (PDF to osobny,
 * cięższy tor — patrz `render/renderer.renderPdfFromHtml`).
 * Dane wejściowe: `examples/invoice-payload.json`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { renderInvoiceHtml, createTranslator, buildThemeCss, SUPPORTED_LANGS } = require('../render/renderer');

const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'invoice-payload.json'), 'utf8'));

/** @returns {any} świeża kopia payloadu (testy nie mogą się nawzajem zanieczyszczać) */
function ctx(overrides = {}) {
  const base = JSON.parse(JSON.stringify(payload));
  return {
    invoice: { ...base.invoice, ...(overrides.invoice || {}) },
    profile: { ...base.profile, ...(overrides.profile || {}) },
    template: overrides.template || {},
    logoDataUri: overrides.logoDataUri || ''
  };
}

test('i18n: wszystkie języki mają ten sam zestaw kluczy', () => {
  const pl = Object.keys(require('../i18n/pl.json')).sort();
  for (const lang of SUPPORTED_LANGS.filter((l) => l !== 'pl')) {
    const keys = Object.keys(require(`../i18n/${lang}.json`)).sort();
    assert.deepEqual(keys, pl, `słownik ${lang} rozjechał się z pl`);
  }
});

test('tłumacz: nieznany klucz zwraca sam klucz (widoczny na wydruku)', () => {
  const t = createTranslator('pl');
  assert.equal(t('doc.invoice'), 'Faktura VAT');
  assert.equal(t('nie.ma.takiego'), 'nie.ma.takiego');
});

test('tłumacz: nieobsługiwany język wpada na polski', () => {
  const t = createTranslator('xx');
  assert.equal(t('doc.invoice'), 'Faktura VAT');
});

test('render: dokument zawiera numer, strony i kwoty w walucie dokumentu', () => {
  const html = renderInvoiceHtml(ctx());

  assert.match(html, /FV\/2026\/08\/0042/);
  assert.match(html, /HKL Dekoracja Okien/);
  assert.match(html, /Fenster &amp; Sonnenschutz GmbH/, 'nazwa nabywcy escapowana');
  assert.match(html, /DE123456789/);
  // 2 099,00 EUR netto — separator zależny od locale dokumentu (de)
  assert.match(html, /2\.099,00/, 'kwoty formatowane w locale dokumentu (de)');
  assert.match(html, /1\.523,00/, 'do zapłaty po odliczeniu zaliczki');
});

test('render: język dokumentu decyduje o etykietach', () => {
  const de = renderInvoiceHtml(ctx());
  assert.match(de, /Schlussrechnung/, 'documentType=final w języku de');
  assert.match(de, /Innergemeinschaftliche Lieferung/, 'adnotacja WDT po niemiecku');

  const pl = renderInvoiceHtml(ctx({ invoice: { lang: 'pl' } }));
  assert.match(pl, /Faktura końcowa/);
  assert.match(pl, /Wewnątrzwspólnotowa dostawa towarów/);
});

test('render: podsumowanie VAT ma wiersz na każdą parę (stawka, kategoria)', () => {
  const html = renderInvoiceHtml(ctx());
  const rows = html.match(/<tr>\s*<td>\d/g) || [];
  assert.ok(rows.length >= 2, 'dwa wiersze: 8% obniżona i 0% WDT');
  assert.match(html, /8%/);
  assert.match(html, /0%/);
});

test('render: podsumowanie VAT rozróżnia kategorie o tej samej stawce', () => {
  const html = renderInvoiceHtml(ctx({ invoice: { lang: 'pl' } }));
  // Payload ma 8% (krajowa obniżona) i 0% (WDT) — bez kolumny kategorii dwa
  // wiersze 0% (np. WDT i eksport) byłyby na wydruku nierozróżnialne.
  assert.match(html, /Krajowa obniżona/);
  assert.match(html, /WDT/);
  assert.match(html, /<th>Rodzaj<\/th>/);
});

test('render: dokument NIE pokazuje przeliczenia VAT na walutę krajową', () => {
  // ⚠️ Blok „VAT w PLN + kurs NBP" został świadomie usunięty z wydruku.
  // Kwoty są nadal liczone i zapisywane (`totalTaxLocal`, `exchangeRate`),
  // więc test pilnuje, że nie wracają na dokument przypadkiem — np. przy
  // przywracaniu innego fragmentu szablonu.
  const html = renderInvoiceHtml(ctx());
  assert.doesNotMatch(html, /<div class="vat-local">/, 'sekcja przeliczenia nie jest renderowana');
  assert.doesNotMatch(html, /NBP:149\/A\/NBP\/2026/, 'źródło kursu nie trafia na wydruk');
  assert.doesNotMatch(html, /102,33/, 'kwota VAT w PLN nie trafia na wydruk');
  // Kwoty w walucie dokumentu zostają nietknięte
  assert.match(html, /2\.099,00|2 099,00/, 'suma netto w EUR nadal na dokumencie');
});

test('render: brak kursu nie drukuje już ostrzeżenia (sekcji nie ma wcale)', () => {
  const html = renderInvoiceHtml(ctx({ invoice: { totalTaxLocal: null, exchangeRate: null } }));
  assert.doesNotMatch(html, /Wechselkurs nicht verfügbar/, 'ostrzeżenie o kursie zniknęło razem z sekcją');
  assert.doesNotMatch(html, /NBP:/, 'bez sekcji nie ma źródła kursu');
});

test('render: ilość to liczba SZTUK, wymiary idą do własnej kolumny', () => {
  const html = renderInvoiceHtml(ctx({ invoice: { lang: 'pl' } }));
  // ⚠️ Żaden produkt nie jest rozliczany na m² — ilość pochodzi z ILOSC.
  assert.match(html, /szt\./, 'jednostka to sztuki');
  assert.doesNotMatch(html, /m²/, 'metry kwadratowe nie mogą trafić na dokument');
  // Powierzchnia zostaje w danych technicznych, ale nie jako ilość
  assert.match(html, /1232×1232 mm/, 'wymiary w kolumnie „Wymiary"');
  assert.match(html, /<th class="col-dim">Wymiary<\/th>/);
});

test('render: proforma dostaje klauzulę o braku skutków podatkowych', () => {
  const proforma = renderInvoiceHtml(ctx({ invoice: { documentType: 'proforma', lang: 'pl' } }));
  assert.match(proforma, /nie jest fakturą VAT/);

  const final = renderInvoiceHtml(ctx({ invoice: { lang: 'pl' } }));
  assert.doesNotMatch(final, /nie jest fakturą VAT/);
});

test('render: korekta pokazuje przyczynę i dokument korygowany', () => {
  const html = renderInvoiceHtml(ctx({
    invoice: {
      documentType: 'correction',
      lang: 'pl',
      correctionReason: 'Zwrot jednej rolety',
      correctedInvoiceNumber: 'FV/2026/07/0011'
    }
  }));
  assert.match(html, /Faktura korygująca/);
  assert.match(html, /Zwrot jednej rolety/);
  assert.match(html, /FV\/2026\/07\/0011/);
});

test('render: dane bankowe z profilu organizacji', () => {
  const html = renderInvoiceHtml(ctx());
  assert.match(html, /mBank S\.A\./);
  assert.match(html, /PL61 1090 1014 0000 0712 1981 2874/);
  assert.match(html, /BREXPLPWMBK/);
});

test('render: stopka organizacji w języku dokumentu', () => {
  const de = renderInvoiceHtml(ctx());
  assert.match(de, /Stammkapital/, 'stopka de z profilu');
  const pl = renderInvoiceHtml(ctx({ invoice: { lang: 'pl' } }));
  assert.match(pl, /kapitał zakładowy/);
});

test('motyw: zmienne organizacji nadpisują zmienne szablonu', () => {
  const css = buildThemeCss({ accent: '#111111', font: 'Arial' }, { accent: '#8a6d0b' });
  assert.match(css, /--accent: #8a6d0b;/);
  assert.match(css, /--font: Arial;/);
});

test('motyw: wartości z bazy nie mogą wstrzyknąć CSS-a', () => {
  const css = buildThemeCss({}, {
    accent: '#fff; } body { display:none } .x {',
    'zły klucz': '#fff',
    ok: '#abcdef'
  });
  assert.doesNotMatch(css, /display:none/, 'wartość z nawiasami/średnikami odrzucona');
  assert.doesNotMatch(css, /zły klucz/, 'nazwa niepasująca do [a-z0-9-] odrzucona');
  assert.match(css, /--ok: #abcdef;/);
});

test('render: szkic bez numeru nie wysadza szablonu', () => {
  const html = renderInvoiceHtml(ctx({ invoice: { number: null, status: 'draft' } }));
  assert.match(html, /—/, 'brak numeru zaznaczony półpauzą');
});

test('render: dokument bez zaliczek nie pokazuje wiersza zaliczek', () => {
  const html = renderInvoiceHtml(ctx({ invoice: { advanceSettled: 0, amountDue: 212300, lang: 'pl' } }));
  assert.doesNotMatch(html, /Zapłacone zaliczki/);
});
