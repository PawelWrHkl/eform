/**
 * Symulator tworzenia pozycji — przechodzi przez konfigurator tak, jak człowiek.
 *
 * Dział → grupa → wypełnienie wszystkich aktywnych pól → werdykt. Zdany test to
 * kompletna, poprawna konfiguracja z niezerową ceną; niezdany to konkretna
 * informacja, co blokuje.
 *
 * DLACZEGO W PRAWDZIWEJ PRZEGLĄDARCE, a nie bezgłowo (patrz SILNIK-KONFIGURATORA.md §10):
 *
 *  - `services/formEngine` woła `applyFormulaParams()` PO kaskadzie cenowej, więc
 *    skrypt ceny widzi jeszcze niewyliczony parametr formułowy. Zmierzone na
 *    grupie 73 #6449: przeglądarka 96.28, bezgłowo 38.02.
 *  - „Według cennika" w polu ceny to WŁASNY sygnał silnika, że cena wyszła 0
 *    (`pricesCalculator.js checkIfPriceIsCorrect`) — nie da się go zobaczyć poza
 *    prawdziwym przebiegiem, a jest lepszym wykrywaczem niż własna heurystyka.
 *  - `window.inputsValidators` (MIN/MAX) powstaje dopiero z `PROC` wybranej
 *    wartości, więc granice wymiarów istnieją wyłącznie w trakcie realnego wyboru.
 *
 * WERDYKT WYDAJE WALIDATOR APLIKACJI, NIE TEN MODUŁ. `validateAllFieldsOnSubmit`
 * i `checkFlags` są importowane dynamicznie w kontekście strony
 * (`import('/scripts/formTools/validateUtils.js')`) — czyli automat pyta ten sam
 * kod, który uruchamia przycisk zapisu. Żadna reguła walidacji nie jest tu
 * powtórzona, a `form.js`/`main.js` pozostają nietknięte.
 *
 * ⚠️ NIE ZAPISUJE POZYCJI. `#show-button` nie jest klikany, więc nic nie trafia do
 * bazy — symulacja kończy się na „ta konfiguracja przeszłaby walidację i ma cenę".
 * Rzeczywisty zapis wymagałby markera AUTO-TEST, którego w kodzie nie ma.
 */

'use strict';

const { log } = require('./logger');

/** Ile razy obejść pętlę wypełniania — wybór jednego pola odsłania kolejne. */
const MAX_FILL_ROUNDS = 12;
const CALC_TIMEOUT_MS = Number(process.env.CONFIGTEST_BROWSER_TIMEOUT_MS) || 45000;

/**
 * Tekst, którym silnik zastępuje cenę, gdy wyszła 0. Rozpoznawany po treści, bo
 * pochodzi z tłumaczeń (`t('form.pricelist_info')`) i w każdym języku brzmi inaczej;
 * dlatego dodatkowo sprawdzamy, czy wartość nie jest liczbą.
 */
const PRICE_PLACEHOLDER_HINTS = ['cennik', 'pricelist', 'prijslijst', 'preisliste'];

/**
 * Parametry, których zerowa wartość eForm traktuje jako brak ceny — kopia
 * `priceParams` z `pricesCalculator.checkIfPriceIsCorrect()`, świadomie ta sama
 * i tylko ta trójka. Reszta wierszy cenowych (dopłaty, rabaty) bywa zerowa
 * zupełnie legalnie.
 */
const EFORM_PRICE_PARAMS = ['CENA', 'CENA_SUMA', 'SUMA_BRUTTO'];

function looksLikePricePlaceholder(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (text === '') return false;
  if (Number.isFinite(parseFloat(text.replace(',', '.')))) return false;
  const lowered = text.toLowerCase();
  return PRICE_PLACEHOLDER_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * Czekanie na koniec obliczeń — `finishFlag` wstaje 1300 ms PO updateProcedure.
 *
 * ⚠️ Na ŚWIEŻYM formularzu `finishFlag` zostaje `false`, bo `updateProcedure`
 * jeszcze się nie uruchomił — on startuje dopiero od pierwszej zmiany pola.
 * Dlatego to czekanie ma sens tylko PO zmianie, a timeout nie jest błędem: gdy
 * nic się nie liczy, `isCalculating` i tak jest `false` i można iść dalej.
 */
async function waitForCalculations(page, timeout = CALC_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      () => window.finishFlag === true && window.isCalculating !== true,
      { timeout }
    );
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Formularz jest gotowy do sterowania dopiero, gdy istnieje `window.formInputs`.
 *
 * `generateForm` przypisuje je **na samym końcu** (`form.js:452`), już po zbudowaniu
 * wszystkich kontrolek. Wcześniej `window.enabledParams` bywa już częściowo
 * wypełnione (widziane: 6 pozycji, docelowo 17), więc czytanie stanu w tym okienku
 * daje listę parametrów bez ani jednej kontrolki — i symulacja „nie ma czego
 * wypełnić". Dlatego czekamy na kontrolki, a potem aż liczba aktywnych parametrów
 * przestanie rosnąć.
 */
async function waitForFormReady(page, timeout = CALC_TIMEOUT_MS) {
  await page.waitForFunction(
    () => !!window.formInputs && Object.keys(window.formInputs).length > 0 && !!window.formValues,
    { timeout }
  );

  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const count = await page.evaluate(() => Object.keys(window.enabledParams || {}).length);
    if (count === previous && count > 0) return count;
    previous = count;
    await page.waitForTimeout(500);
  }
  return previous;
}

/**
 * Pola, które wciąż czekają na wartość.
 *
 * Bierzemy `window.enabledParams` — dokładnie ten zbiór, który waliduje
 * `validateAllFieldsOnSubmit` — i odsiewamy parametry liczone (silnik sam je
 * wypełnia) oraz ukryte.
 */
async function readPendingFields(page) {
  return page.evaluate(() => {
    const pending = [];
    for (const name of Object.keys(window.enabledParams || {})) {
      const el = (window.formInputs || {})[name];
      if (!el) continue;
      if (window.calculatedParams && window.calculatedParams.has(name)) continue;
      if (window.manualParams && window.manualParams.has(name)) continue;

      const wrapper = document.querySelector(`.${name}-select-area`);
      const hidden = !wrapper || wrapper.offsetParent === null;
      const value = el.value === undefined || el.value === null ? '' : String(el.value).trim();
      if (value !== '' && value !== '<NULL>') continue;

      pending.push({
        name,
        tag: el.tagName,
        type: el.type || '',
        hidden,
        disabled: !!el.disabled,
        // Ile legalnych opcji widzi formularz — pusta lista przy wymaganym polu
        // to dokładnie scenariusz „konfigurator nie puszcza dalej".
        optionCount: el.tagName === 'SELECT'
          ? Array.from(el.options).filter((o) => !o.disabled && o.value && o.value !== '<NULL>').length
          : null
      });
    }
    return pending;
  });
}

/** Zakres, który silnik sam wpisał do walidatorów dla tego pola. */
async function readFieldRange(page, name) {
  return page.evaluate((field) => {
    let min = null;
    let max = null;
    const validators = window.inputsValidators || {};
    for (const models of Object.values(validators)) {
      for (const [model, rules] of Object.entries(models)) {
        // Walidator obowiązuje, gdy jego wartość-klucz jest aktualnie wybrana —
        // ta sama zasada, co w findAllValidatorsForInput().
        if (!Object.values(window.formValues || {}).includes(model)) continue;
        const rule = rules && rules[field];
        if (!rule) continue;
        const lo = Number(rule.MIN2 ?? rule.MIN);
        const hi = Number(rule.MAX2 ?? rule.MAX);
        if (Number.isFinite(lo)) min = min === null ? lo : Math.max(min, lo);
        if (Number.isFinite(hi)) max = max === null ? hi : Math.min(max, hi);
      }
    }
    return { min, max };
  }, name);
}

/**
 * Wybór wartości dla pola przyciskowego (tkaniny, kolory).
 *
 * Kontrakt dialogu (`dialogUtils_copy.js handleOptionClick`): przy wyborze
 * jednokrotnym klik na `.image-box` SAM woła `#dialog-confirm`, przy
 * wielokrotnym trzeba potwierdzić ręcznie.
 */
async function fillButtonField(page, name) {
  await page.click(`#${name}`);
  try {
    await page.waitForSelector('#color-dialog .image-box', { timeout: 15000, state: 'visible' });
  } catch (_err) {
    await page.evaluate(() => document.getElementById('color-dialog')?.close());
    return { ok: false, reason: 'dialog wyboru nie pokazał żadnej opcji' };
  }

  const boxes = await page.$$('#color-dialog .image-box:not(.disabled)');
  if (!boxes.length) {
    await page.evaluate(() => document.getElementById('color-dialog')?.close());
    return { ok: false, reason: 'dialog wyboru nie ma dostępnych opcji' };
  }

  // Co dokładnie wybieramy — bez tego niezdanego testu nie da się odtworzyć.
  const chosen = await boxes[0].evaluate((box) => {
    const nameEl = box.querySelector('.image-name');
    return nameEl ? (nameEl.dataset.value || nameEl.textContent || '').trim() : '';
  }).catch(() => '');

  await boxes[0].click();
  // Wybór wielokrotny nie potwierdza się sam.
  const stillOpen = await page.evaluate(() => !!document.getElementById('color-dialog')?.open);
  if (stillOpen) {
    await page.click('#dialog-confirm').catch(() => {});
  }
  await page.evaluate(() => document.getElementById('color-dialog')?.close());

  // Wartość czytamy z przycisku, nie z dialogu: `getInfoFromDialog` potrafi ją
  // znormalizować (np. obciąć sufiks `~1` aliasu), a liczy się to, co trafiło
  // do konfiguracji.
  const applied = await page.evaluate((field) => (window.formValues || {})[field] ?? '', name);
  return { ok: true, value: applied || chosen };
}

/**
 * Wartość dla pola liczbowego.
 *
 * Najpierw pytamy silnik o zakres (`inputsValidators`), bo tylko on wie, co dany
 * model dopuszcza. Gdy zakresu nie ma — model go jeszcze nie ustawił — wpisujemy
 * wartość zachowawczą i pozwalamy walidacji się wypowiedzieć; jeśli odrzuci,
 * odczytujemy podpowiedziany zakres z etykiety i poprawiamy.
 */
async function fillNumericField(page, name, fallback) {
  const { min, max } = await readFieldRange(page, name);
  let value = fallback;
  if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
    value = Math.round((min + max) / 2);
  } else if (Number.isFinite(min)) {
    value = Math.max(fallback, min);
  } else if (Number.isFinite(max)) {
    value = Math.min(fallback, max);
  }

  await page.fill(`#${name}`, String(value));
  await page.waitForTimeout(700);
  await waitForCalculations(page, 20000);

  const verdict = await page.evaluate((field) => {
    const el = document.getElementById(field);
    const label = document.getElementById(`${field}-label`);
    return {
      rejected: !!el && el.classList.contains('invalid-input'),
      hint: label ? label.textContent : (el && el._manualHint ? el._manualHint.textContent : '')
    };
  }, name);

  if (!verdict.rejected) return { ok: true, value };

  // Silnik pokazuje dozwolony zakres jako „min: X - max: Y" — użyjmy go.
  const parsed = /min:\s*(-?\d+(?:[.,]\d+)?)\s*-\s*max:\s*(-?\d+(?:[.,]\d+)?)/i.exec(verdict.hint || '');
  if (!parsed) return { ok: false, reason: `pole ${name}: wartość ${value} odrzucona, bez podpowiedzi zakresu` };

  const lo = parseFloat(parsed[1].replace(',', '.'));
  const hi = parseFloat(parsed[2].replace(',', '.'));
  const corrected = Math.round((lo + hi) / 2);
  await page.fill(`#${name}`, String(corrected));
  await page.waitForTimeout(700);
  await waitForCalculations(page, 20000);

  const stillRejected = await page.evaluate(
    (field) => !!document.getElementById(field)?.classList.contains('invalid-input'), name
  );
  return stillRejected
    ? { ok: false, reason: `pole ${name}: odrzucone także dla ${corrected} z zakresu ${lo}-${hi}` }
    : { ok: true, value: corrected, corrected: true };
}

/** Pierwsza legalna opcja listy rozwijanej. */
async function fillSelectField(page, name) {
  const options = await page.evaluate((field) => {
    const el = document.getElementById(field);
    if (!el || el.tagName !== 'SELECT') return [];
    return Array.from(el.options)
      .filter((o) => !o.disabled && o.value && o.value !== '<NULL>')
      .map((o) => o.value);
  }, name);

  if (!options.length) return { ok: false, reason: `pole ${name}: lista wymaganego pola jest pusta` };
  await page.selectOption(`#${name}`, options[0]);
  return { ok: true, value: options[0] };
}

/**
 * Stan cen odczytany REGUŁAMI EFORMA, nie własnymi.
 *
 * Trzy rzeczy pochodzą wprost z aplikacji, dynamicznym importem — żadna nie jest
 * tu odtworzona, więc nie może się rozjechać z produkcją:
 *
 *  1. **Które parametry są cenowe** — `LISTROW === '2' || LISTSUM === 'true'`,
 *     dokładnie to samo kryterium, którego używa `setListRow()` i
 *     `applyPriceFactor()` w `form.js`.
 *  2. **Reguła zerowej ceny** — `pricesCalculator.checkIfPriceIsCorrect()`.
 *     Sprawdza wyłącznie te z `CENA`/`CENA_SUMA`/`SUMA_BRUTTO`, które w tym
 *     formularzu ISTNIEJĄ (`inputs[p] !== undefined`), i tylko gdy widoczne
 *     `SZEROKOSC`/`WYSOKOSC` są wypełnione. Ten filtr jest istotny: bez niego
 *     każda grupa bez `SUMA_BRUTTO` byłaby fałszywie zgłaszana (patrz komentarz
 *     w `pricesCalculator.js`).
 *  3. **Sumy pozycji** — `form.js getTotal(displayValues)`, ta sama funkcja,
 *     która wylicza `total`/`total_sub` zapisywane do `order_item`. Dzięki temu
 *     sprawdzamy liczbę, która faktycznie poszłaby do bazy, a nie to, co widać.
 *
 * `checkIfPriceIsCorrect` podmienia pola cenowe na „Według cennika", gdy cena
 * wyszła 0 — dlatego wołamy ją PO odczytaniu surowych wartości i traktujemy jej
 * efekt jako werdykt aplikacji, nie jako uszkodzenie stanu (silnik i tak robi to
 * na końcu każdego `updateFieldStates`).
 */
async function readPriceState(page) {
  return page.evaluate(async () => {
    const formModule = await import('/scripts/form.js');
    const pricesModule = await import('/scripts/formTools/pricesCalculator.js');

    const params = window.params || [];
    const inputs = window.formInputs || {};
    const values = window.formValues || {};
    const displayValues = window.formDisplayValues;

    // (1) Parametry cenowe wg kryterium eForma.
    const priceParams = params
      .filter((p) => p && p.NAME && (p.LISTROW == '2' || p.LISTSUM == 'true'))
      .map((p) => ({
        name: p.NAME,
        listsum: p.LISTSUM == 'true',
        exists: inputs[p.NAME] !== undefined,
        sub: String(p.NAME).startsWith('SUB___'),
        rawValue: values[p.NAME],
        onScreen: inputs[p.NAME] ? inputs[p.NAME].value : null
      }));

    // (3) Sumy tak, jak policzy je zapis pozycji.
    let totals = null;
    try {
      totals = displayValues ? formModule.getTotal(displayValues) : null;
    } catch (err) {
      totals = { error: err.message };
    }

    // (2) Reguła eForma. Zwraca displayValues; skutkiem ubocznym jest podmiana
    // pól na „Według cennika", więc porównujemy stan pól przed i po.
    const before = {};
    for (const p of priceParams) if (p.exists) before[p.name] = inputs[p.name].value;
    try {
      pricesModule.checkIfPriceIsCorrect(values, inputs, displayValues);
    } catch (err) {
      /* reguła sama zgłasza problem tylko przez podmianę pól */
    }
    // Podmiana leci w setTimeout(150) — dajmy jej dojść.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = {};
    for (const p of priceParams) if (p.exists) after[p.name] = inputs[p.name].value;

    const replacedByEngine = Object.keys(after).filter((name) => after[name] !== before[name]);

    return { priceParams, totals, before, after, replacedByEngine };
  });
}

/**
 * Ceny widoczne na ekranie plus werdykt walidatora APLIKACJI.
 *
 * `validateAllFieldsOnSubmit` ustawia `afterSend = true` i przelicza `inputFlags`
 * dokładnie tak, jak przy zapisie — tylko zapisu nie wykonujemy.
 */
async function readVerdict(page) {
  return page.evaluate(async () => {
    const vu = await import('/scripts/formTools/validateUtils.js');
    vu.validateAllFieldsOnSubmit(window.formInputs, window.formValues);
    const flags = vu.checkFlags();

    const prices = {};
    for (const name of ['CENA', 'CENA_SUMA', 'SUMA_BRUTTO', 'CENA_KONCOWA', 'WARTOSC_KONCOWA']) {
      const el = document.getElementById(name);
      if (el) prices[name] = el.value;
    }

    return {
      valid: flags === true,
      invalidFields: Array.isArray(flags) ? flags.map((f) => f.key) : [],
      prices,
      activeParams: Object.keys(window.enabledParams || {}).length,
      values: window.formValues || {},
      scripts: (window.params || []).reduce((acc, p) => {
        if (p && p.NAME) acc[p.NAME] = p.SCRIPTS;
        return acc;
      }, {})
    };
  });
}

/**
 * Jedna symulacja: od wyboru działu do werdyktu.
 *
 * @param {object} opts
 * @param {import('playwright').Page} opts.page
 * @param {string} opts.appUrl
 * @param {number|string} opts.orderId    istniejące zamówienie, w którym otwieramy nową pozycję
 * @param {string} opts.departmentNumber
 * @param {string} opts.groupNumber
 * @param {number} [opts.numericFallback] wartość dla pola liczbowego bez zakresu
 * @returns {Promise<object>} wynik symulacji (bez zapisu do bazy)
 */
async function simulatePosition({
  page, appUrl, orderId, departmentNumber, groupNumber, numericFallback = 1000
}) {
  const result = {
    groupNumber,
    departmentNumber,
    ok: false,
    stage: 'start',
    filled: [],
    blocked: [],
    unsupported: [],
    invalidFields: [],
    prices: {},
    reason: ''
  };

  await page.goto(`${appUrl}/orders/order/${orderId}/new-position/`);
  await page.waitForLoadState('networkidle');

  // Dział → lista grup. Grupy pojawiają się asynchronicznie (prod.txt per grupa).
  result.stage = 'dział';
  try {
    await page.selectOption('#department-select', String(departmentNumber));
    await page.waitForFunction(
      () => document.querySelectorAll('#asortment-group-select option').length > 1,
      { timeout: CALC_TIMEOUT_MS }
    );
  } catch (_err) {
    result.reason = `nie udało się wybrać działu ${departmentNumber} albo dział nie ma żadnej grupy`;
    return result;
  }

  result.stage = 'grupa';
  const groupAvailable = await page.evaluate(
    (code) => Array.from(document.querySelectorAll('#asortment-group-select option')).some((o) => o.value === String(code)),
    groupNumber
  );
  if (!groupAvailable) {
    // prod.txt ma whitelistę `users` — grupa może być niedostępna dla tego konta.
    result.reason = `grupa ${groupNumber} nie jest dostępna w dziale ${departmentNumber} dla tego konta (whitelista \`users\` w prod.txt)`;
    return result;
  }
  await page.selectOption('#asortment-group-select', String(groupNumber));

  result.stage = 'budowa formularza';
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#dynamic-form select, #dynamic-form input, #dynamic-form button').length > 3,
      { timeout: CALC_TIMEOUT_MS }
    );
    // Bez tego symulacja startuje, gdy `window.formInputs` jeszcze nie istnieje,
    // i nie ma czego wypełniać — patrz waitForFormReady().
    result.activeParams = await waitForFormReady(page);
  } catch (_err) {
    result.reason = 'formularz konfiguracji nie zbudował się';
    return result;
  }

  result.stage = 'wypełnianie';
  for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
    const pending = await readPendingFields(page);
    const fillable = pending.filter((f) => !f.hidden && !f.disabled && f.type !== 'file');
    if (!fillable.length) break;

    let progressed = false;
    for (const field of fillable) {
      let outcome;
      if (field.tag === 'SELECT') outcome = await fillSelectField(page, field.name);
      else if (field.tag === 'BUTTON') outcome = await fillButtonField(page, field.name);
      else if (field.type === 'number' || field.type === 'text') {
        // Pola tekstowe bez słownika (np. CIEZARMAT — ciężar materiału) i tak
        // przyjmują liczbę; jeśli silnik ma dla nich zakres, użyjemy go.
        outcome = await fillNumericField(page, field.name, numericFallback);
      } else {
        // ⚠️ To ograniczenie SYMULATORA, nie usterka konfiguratora. Nie wolno
        // tego raportować jako „konfigurator nie puszcza dalej" — pole może być
        // całkowicie w porządku, tylko automat nie umie go prowadzić.
        outcome = { ok: false, unsupported: true, reason: `nieobsługiwany typ kontrolki (${field.tag}/${field.type})` };
      }

      if (outcome.ok) {
        result.filled.push({ name: field.name, value: outcome.value, corrected: !!outcome.corrected });
        progressed = true;
        await waitForCalculations(page, 20000);
      } else if (outcome.unsupported) {
        if (!result.unsupported.some((u) => u.name === field.name)) {
          result.unsupported.push({ name: field.name, reason: outcome.reason });
        }
      } else {
        // Puste pole wymagane bez ani jednej opcji to sedno zgłoszenia
        // „konfigurator nie puszcza dalej" — zapisujemy z powodem.
        if (!result.blocked.some((b) => b.name === field.name)) {
          result.blocked.push({ name: field.name, reason: outcome.reason, optionCount: field.optionCount });
        }
      }
    }

    // Nic się nie udało wypełnić, a pola nadal czekają — dalsze rundy nic nie dadzą.
    if (!progressed) break;
  }

  // Zakres pola liczbowego zmienia się po kolejnych wyborach (`USTAW` z `PROC`
  // nowo wybranej wartości), więc wartość wpisana wcześniej może przestać być
  // dopuszczalna. Zmierzone na grupie 11: WYSOKOSC=1725 przyjęta w trakcie,
  // odrzucona na końcu. Poprawiamy przed wydaniem werdyktu — inaczej
  // oskarżylibyśmy konfigurator o regułę, której sami nie dopilnowaliśmy.
  result.stage = 'korekta zakresów';
  const stale = await page.evaluate(() => Object.keys(window.enabledParams || {})
    .filter((name) => {
      const el = (window.formInputs || {})[name];
      return !!el && el.tagName === 'INPUT' && el.classList.contains('invalid-input');
    }));
  for (const name of stale) {
    const retry = await fillNumericField(page, name, numericFallback);
    if (retry.ok) result.filled.push({ name, value: retry.value, corrected: true });
    else if (!result.blocked.some((b) => b.name === name)) {
      result.blocked.push({ name, reason: retry.reason });
    }
  }

  result.stage = 'werdykt';
  await waitForCalculations(page, 20000);
  // Ceny sprawdzamy regułami eForma (readPriceState) PRZED walidatorem, bo
  // reguła zerowej ceny podmienia pola i chcemy zobaczyć oba stany.
  const priceState = await readPriceState(page);
  const verdict = await readVerdict(page);

  result.invalidFields = verdict.invalidFields;
  result.prices = verdict.prices;
  result.priceParams = priceState.priceParams;
  result.totals = priceState.totals;
  // Pola, które SILNIK sam podmienił na „Według cennika" po uruchomieniu swojej
  // reguły — to jego własna deklaracja „nie umiem tego wycenić".
  result.replacedByEngine = priceState.replacedByEngine;
  result.activeParams = verdict.activeParams;
  result.values = verdict.values;
  result.scripts = verdict.scripts;

  // Placeholder rozpoznajemy dwoma niezależnymi drogami: po treści pola oraz po
  // tym, że reguła eForma sama je podmieniła. Suma zbiorów, bo pole mogło już
  // być podmienione przez silnik przed naszym odczytem.
  const placeholderPrices = [...new Set([
    ...Object.entries(priceState.after)
      .filter(([, value]) => looksLikePricePlaceholder(value))
      .map(([name]) => name),
    ...priceState.replacedByEngine
  ])];
  // Zerowa cena — DOKŁADNIE zakres reguły eForma: `CENA`, `CENA_SUMA`,
  // `SUMA_BRUTTO`, i tylko te, które w tym formularzu istnieją
  // (`pricesCalculator.checkIfPriceIsCorrect`).
  //
  // ⚠️ NIE wszystkie wiersze cenowe. Zerowa `DOPLATA_EL`, `CENA_RABAT` czy
  // `DOPLATA_EL_RABAT` to normalny stan (brak dopłaty elektrycznej, brak
  // rabatu) — liczenie ich dało fałszywe P1 na grupie 43, która ma poprawną
  // cenę 179 i sumę 191.2.
  const zeroPriceParams = priceState.priceParams
    .filter((p) => p.exists && !p.sub && EFORM_PRICE_PARAMS.includes(p.name))
    .filter((p) => {
      const raw = p.rawValue;
      return raw === '' || raw === null || raw === undefined || raw == 0;
    })
    .map((p) => p.name);
  result.zeroPriceParams = zeroPriceParams;
  // Pozostałe zerowe wiersze zostają jako informacja, bez wpływu na werdykt.
  result.otherZeroPriceRows = priceState.priceParams
    .filter((p) => p.exists && !p.sub && !EFORM_PRICE_PARAMS.includes(p.name))
    .filter((p) => p.rawValue == 0)
    .map((p) => p.name);

  const totalValue = parseFloat(priceState.totals?.total);
  const anyPositivePrice = priceState.priceParams
    .filter((p) => p.exists && EFORM_PRICE_PARAMS.includes(p.name))
    .some((p) => parseFloat(String(p.rawValue).replace(',', '.')) > 0);
  result.totalFromApp = Number.isFinite(totalValue) ? totalValue : null;

  result.pricePlaceholders = placeholderPrices;
  // „Ma cenę" = żadne istniejące pole cenowe nie jest zerowe, nic nie zostało
  // podmienione na informację z cennika, i suma, która poszłaby do bazy
  // (`getTotal`), jest dodatnia.
  result.hasPrice = anyPositivePrice
    && placeholderPrices.length === 0
    && zeroPriceParams.length === 0
    && (result.totalFromApp === null || result.totalFromApp > 0);
  // Konfiguracja jest kompletna tylko wtedy, gdy NIC nie zostało niewypełnione —
  // ani z powodu braku opcji, ani z powodu ograniczeń symulatora. Zerowa cena
  // przy niekompletnej konfiguracji nie mówi nic o poprawności wyceny.
  result.complete = result.blocked.length === 0 && result.unsupported.length === 0;
  result.ok = verdict.valid && result.hasPrice && result.complete;

  result.reason = result.ok
    ? `Konfiguracja zbudowana i przeszłaby walidację: ${result.filled.length} pól wypełnionych, ${verdict.activeParams} parametrów aktywnych, ${priceState.priceParams.filter((p) => p.exists).length} parametrów cenowych sprawdzonych, cena ${verdict.prices.CENA ?? '—'}, suma do zapisu ${result.totalFromApp ?? '—'}.`
    : [
      result.blocked.length ? `pola bez możliwej wartości: ${result.blocked.map((b) => b.name).join(', ')}` : '',
      result.unsupported.length ? `pola, których symulator nie umie wypełnić: ${result.unsupported.map((u) => u.name).join(', ')}` : '',
      verdict.valid ? '' : `walidacja aplikacji odrzuca: ${verdict.invalidFields.join(', ') || 'bez listy'}`,
      placeholderPrices.length ? `cena zastąpiona informacją z cennika (silnik policzył 0): ${placeholderPrices.join(', ')}` : '',
      zeroPriceParams.length && !placeholderPrices.length ? `zerowe parametry cenowe: ${zeroPriceParams.join(', ')}` : '',
      result.totalFromApp === 0 ? 'suma pozycji liczona przez getTotal() wynosi 0 — taka wartość poszłaby do bazy' : '',
      !anyPositivePrice && !placeholderPrices.length && !zeroPriceParams.length ? 'żadne pole cenowe nie pokazuje wartości > 0' : ''
    ].filter(Boolean).join('; ');

  log(`ConfiguratorTester (symulacja): grupa ${groupNumber} — ${result.ok ? 'ZDANE' : 'NIEZDANE'}: ${result.reason}`);
  return result;
}

module.exports = {
  simulatePosition,
  looksLikePricePlaceholder,
  MAX_FILL_ROUNDS
};
