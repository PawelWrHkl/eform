const { getEffectiveOrgId } = require('./subPriceContext');
const { formatAmount } = require('./currency');

const HKL_ORG_ID = 3;

/**
 * Bazowa kwota do rabatu klienta: HKL → zwykłe ceny, inne org → SUB___ (subVisible).
 */
function resolveDiscountBaseTotal(orgId, totals, subTotals) {
  const isHkl = orgId == null || Number(orgId) === HKL_ORG_ID;
  if (isHkl) {
    return parseFloat(totals?.visible) || 0;
  }
  const subVisible = subTotals?.subVisible ?? parseFloat(totals?.sub);
  if (subVisible != null && !Number.isNaN(subVisible) && Number(subVisible) !== 0) {
    return Number(subVisible);
  }
  return parseFloat(totals?.visible) || 0;
}

/**
 * Zwraca true jeśli przynajmniej jedna pozycja ma niepuste subParamValues.
 */
function orderHasSubPrices(cleanOrderItems) {
  if (!Array.isArray(cleanOrderItems)) return false;
  for (const table of cleanOrderItems) {
    if (!table?.rows) continue;
    for (const rowObj of table.rows) {
      const subVals = rowObj?.item?.subParamValues;
      if (Array.isArray(subVals) && subVals.length > 0) return true;
    }
  }
  return false;
}

/**
 * Suma „wartości po rabacie klienta grupy" ze WSZYSTKICH pozycji zamówienia —
 * dokładnie tych liczb, które widok pokazuje przy pozycjach jako „Wartość po
 * rabacie" (`SUB___WARTOSC_PO_RABACIE`, patrz
 * public/scripts/formTools/pricesCalculator.js).
 *
 * ⚠️ Nie da się jej zastąpić `SUM(order_item.total_price_sub)`: ta kolumna
 * powstaje z `form.js getTotal()` i dla pozycji zapisanych przed zmianą
 * podstawy rabatu bywa policzona z innej liczby (np. 14,27 zamiast 40,77) —
 * stopka rozjeżdżałaby się z wierszami pozycji. Tu sumujemy to samo, co widać.
 *
 * ⚠️ Klucz bez prefiksu (`WARTOSC_PO_RABACIE`) też liczymy — tak nazywały się
 * wiersze rabatu zapisane przed 2026-08-21 (patrz services/orderService.js).
 */
function calcClientDiscountTotal(orderItems) {
  let total = 0;
  let found = false;
  if (!Array.isArray(orderItems)) return { total: 0, found: false };

  for (const item of orderItems) {
    let parsed = item?.json_parameters_desc;
    try {
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const entries = parsed instanceof Map
      ? Array.from(parsed.entries())
      : (Array.isArray(parsed) ? parsed : Object.entries(parsed));

    for (const [key, param] of entries) {
      if (key !== 'SUB___WARTOSC_PO_RABACIE' && key !== 'WARTOSC_PO_RABACIE') continue;
      const val = parseFloat(param && typeof param === 'object' ? param.option_value : param);
      if (!isFinite(val)) continue;
      total += val;
      found = true;
    }
  }
  return { total: parseFloat(total.toFixed(2)), found };
}

/** `json_parameters` bywa zapisany podwójnie zakodowanym JSON-em. */
function parseJsonValues(raw) {
  let values = raw;
  try {
    if (typeof values === 'string') values = JSON.parse(values);
    if (typeof values === 'string') values = JSON.parse(values);
  } catch {
    return {};
  }
  return values && typeof values === 'object' ? values : {};
}

/**
 * Wylicza dwa osobne sumy SUB cen z `orderItems`:
 *  - subVisible: suma SUB params z listsum=true i NIE-locked
 *  - subLocked: suma SUB params z listsum=true i locked=true — czyli w praktyce
 *    `SUB___WARTOSC_KONCOWA`, który OD 2026-09-11 niesie już kwotę po rabacie
 *    klienta (pricesCalculator.js `applyClientDiscount`), więc to dokładnie ta
 *    liczba, która idzie do `order_item.total_price_sub`. Pozycje zapisane
 *    WCZEŚNIEJ mają rabat w osobnym wierszu „Wartość po rabacie" — tam ta kwota
 *    ma pierwszeństwo.
 * Per pozycja bierzemy ostatnią wartość listsum (overwrite semantics).
 */
function calcSubTotals(orderItems) {
  let subVisible = 0;
  let subLocked = 0;
  if (!Array.isArray(orderItems)) return { subVisible, subLocked };

  for (const item of orderItems) {
    let parsed = item?.json_parameters_desc;
    try {
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const entries = parsed instanceof Map
      ? Array.from(parsed.entries())
      : (Array.isArray(parsed) ? parsed : Object.entries(parsed));

    let itemVisible = 0;
    let itemLocked = 0;
    let itemAfterDiscount = null;
    let itemHasSubRows = false;
    let itemHasSubSum = false;
    for (const [key, param] of entries) {
      if (!key || !key.startsWith('SUB___') || !param || typeof param !== 'object') continue;
      itemHasSubRows = true;

      // Pozycje sprzed 2026-09-11: rabat miał własny wiersz bez `listsum`, więc
      // pętla poniżej by go pominęła — a to on był ostateczną wartością pozycji.
      // Nowe pozycje takiego wiersza nie mają (rabat siedzi w
      // `SUB___WARTOSC_KONCOWA`), więc ta gałąź dotyczy wyłącznie historii.
      if (key === 'SUB___WARTOSC_PO_RABACIE') {
        const afterVal = parseFloat(param.option_value);
        if (isFinite(afterVal)) itemAfterDiscount = afterVal;
        continue;
      }

      if (!param.listsum) continue;
      itemHasSubSum = true;
      const val = parseFloat(param.option_value);
      if (!isFinite(val)) continue;
      if (param.locked === true) {
        itemLocked = val;
      } else {
        itemVisible = val;
      }
    }

    // Stare pozycje z cenami `SUB___` w opisie, ale BEZ wierszy sum `SUB___`
    // (28 na produkcji, 2026-10-09, m.in. 1283 A&A Lohne): sumy klienta SĄ
    // policzone w `json_parameters`, tylko nie trafiły do `json_parameters_desc`
    // — stopka pokazywała przez to „Według cennika”. Bierzemy je z wartości
    // w układzie sum zwykłych tej samej pozycji: wiersz `SUMA_BRUTTO` (listsum)
    // → `SUB___SUMA_BRUTTO`, zablokowany `WARTOSC_KONCOWA` → `SUB___WARTOSC_KONCOWA`.
    if (itemHasSubRows && !itemHasSubSum) {
      const values = parseJsonValues(item?.json_parameters);
      for (const [key, param] of entries) {
        if (!key || key.startsWith('SUB___') || !param || typeof param !== 'object' || !param.listsum) continue;
        const val = parseFloat(values[`SUB___${key}`]);
        if (!isFinite(val)) continue;
        if (param.locked === true) {
          itemLocked = val;
        } else {
          itemVisible = val;
        }
      }
    }

    // ⚠️ Suma „Razem po rabacie" MUSI być tą samą liczbą, którą zapisano w
    // `order_item.total_price_sub` — inaczej stopka pokazuje inną kwotę, niż
    // zamówienie jest warte. Ta sama zasada, którą stosuje `form.js getTotal()`:
    // gdy istnieje wiersz „Wartość po rabacie", ma pierwszeństwo nad
    // `SUB___WARTOSC_KONCOWA`.
    //
    // Zmierzone na pozycji 7277 (zam. 3078, rabat 1% za korzystanie z serwisu):
    // WARTOSC_KONCOWA = 113.20, WARTOSC_PO_RABACIE = 112.07, w bazie 112.07 —
    // a kafelek pokazywał 113.20.
    subVisible += itemVisible;
    subLocked += itemAfterDiscount !== null ? itemAfterDiscount : itemLocked;
  }
  return {
    subVisible: parseFloat(subVisible.toFixed(2)),
    subLocked: parseFloat(subLocked.toFixed(2))
  };
}

/**
 * Informacja o rabacie eForma do podsumowania dokumentu — procent i opis,
 * dokładnie takie, jakie klient widział przy pozycji.
 *
 * Czytamy `json_parameters_desc` zapisanej pozycji, a nie konfigurację klienta,
 * bo to wiersz pozycji jest źródłem prawdy: rabat mógł się zmienić po złożeniu
 * zamówienia, a dokument ma pokazywać stan z chwili zamówienia.
 *
 * ⚠️ Opis bierzemy ze wpisu (`param_description`), nie tłumaczymy go tutaj —
 * `pricesCalculator.js applyClientDiscount` wylicza go w chwili konfiguracji i
 * to on rozróżnia „rabat klienta" od „1% za korzystanie z serwisu" (a przy obu
 * naraz — łączy oba teksty).
 *
 * Klucz bez prefiksu (`RABAT_KLIENTA`) to zapis sprzed 2026-08-21, patrz
 * services/orderService.js.
 *
 * @returns {{percent:string, label:string}|null}
 */
function resolveClientDiscountSummary(orderItems) {
  if (!Array.isArray(orderItems)) return null;
  for (const item of orderItems) {
    const rabat = resolveItemClientDiscount(item);
    if (rabat) return { percent: rabat.percent, label: rabat.label };
  }
  return null;
}

/**
 * Rabat eForma JEDNEJ pozycji — procent, jego wartość liczbowa i opis.
 *
 * Czytamy najpierw wiersz z `json_parameters_desc` (to, co klient widzi przy
 * pozycji), a gdy go nie ma — `json_parameters.RABAT_KLIENTA`, które
 * `pricesCalculator.applyClientDiscount` zapisuje zawsze, nawet na ekranach bez
 * wierszy rabatu. Dwa źródła, bo pierwsze niesie opis i format („1%"), a drugie
 * jest pewniejsze.
 *
 * ⚠️ To rabat eForma (rabat klienta + bonus za korzystanie z serwisu), NIE
 * rabat cennikowy `SUB___CENA_RABAT` — ten siedzi w cenie i nie jest osobną
 * informacją.
 *
 * @returns {{percent:string, value:number, label:string|null}|null}
 */
function resolveItemClientDiscount(item) {
  if (!item) return null;

  let parsed = item.json_parameters_desc;
  try {
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const entries = parsed instanceof Map
      ? Array.from(parsed.entries())
      : (Array.isArray(parsed) ? parsed : Object.entries(parsed));

    for (const [key, param] of entries) {
      if (key !== 'SUB___RABAT_KLIENTA' && key !== 'RABAT_KLIENTA') continue;
      const raw = param && typeof param === 'object' ? param.option_value : param;
      const percent = String(raw == null ? '' : raw).trim();
      const value = parseFloat(percent);
      // „0%" to brak rabatu — taki wiersz i tak nie trafia do dokumentu
      // (orderService.js `isZeroRabatDisplayValue`).
      if (!percent || !Number.isFinite(value) || value === 0) continue;
      const label = (param && typeof param === 'object' && param.param_description) || null;
      return { percent, value, label };
    }
  }

  let params = item.json_parameters;
  try {
    if (typeof params === 'string') params = JSON.parse(params);
  } catch {
    params = null;
  }
  const fallback = params && typeof params === 'object' ? parseFloat(params.RABAT_KLIENTA) : NaN;
  if (!Number.isFinite(fallback) || fallback === 0) return null;
  return { percent: `${fallback}%`, value: fallback, label: null };
}

/**
 * Określa tryb wyświetlania cen SUB w PDF / mailu (zgodny z widokiem strony).
 */
function resolveSubPricePdfView(req, hasSubPrices) {
  const effectiveOrgId = getEffectiveOrgId(req);
  const nonHklOrg = effectiveOrgId != null && Number(effectiveOrgId) !== 3;
  const sessionUser = req.session?.user;
  const contextUser = req.session?.context_user;
  const showSubActive = sessionUser?.showSubParams || false;

  const isPureClient = !sessionUser?.isOwner && !sessionUser?.isAdmin
    && !sessionUser?.isEmployee && !sessionUser?.isGroup && !sessionUser?.isGroupShop
    && nonHklOrg;

  const hasSubToggle = nonHklOrg && (
    (sessionUser?.isOwner && !sessionUser?.isAdmin) ||
    (sessionUser?.isAdmin && !!contextUser)
  );

  // Użytkownik grupowy (np. TCN — klient HKL z rolą "group"): na stronie sub params
  // są sterowane togglem showSub niezależnie od organizacji (isGroup and showSub).
  // isGroup jest liczone tak samo jak w widoku (routes/orders.js): sesja LUB kontekst.
  // PDF ma odwzorować ten sam widok — ceny zwykłe + sub params, gdy odkryte.
  const isGroup = sessionUser?.isGroup || contextUser?.isGroup || false;
  const groupShowBoth = isGroup && showSubActive && hasSubPrices;

  // ⚠️ Konto podrzędne grupy (`group_user`) NIE MOŻE nigdy dostać cen
  // katalogowych w PDF/mailu — to cena zakupu grupy (patrz WYCIEK,
  // PROJECT_OVERVIEW.md). Bez tego forsowania `isClientView` wychodziło
  // `false` (isGroupShop jest wykluczone z `isPureClient`, a `hasSubToggle`
  // wymaga ownera/admina), więc `order-pdf.njk` (PDF długi + mail — w
  // przeciwieństwie do `order_to_print.njk`, który ma na to osobny,
  // ręczny warunek) renderował mu blok cen katalogowych.
  const isGroupShopSession = !!sessionUser?.isGroupShop;

  const isClientView = isGroupShopSession
    || ((isPureClient || (hasSubToggle && !showSubActive)) && hasSubPrices);
  const showBoth = (hasSubToggle && showSubActive && hasSubPrices) || groupShowBoth;

  return { isClientView, showBoth, hasSubToggle, isPureClient, showSubActive, nonHklOrg };
}

/**
 * Tryb cen w PDF dla KAŻDEJ grupy (`role = 'group'` lub jej konto podrzędne,
 * typu `shop` LUB `client`) — sterowany kłódką "Pokaż cenę po rabacie"
 * (`showDiscountPriceBtn`, public/scripts/order.js), NIE starym togglem
 * `showSubParams` z `resolveSubPricePdfView` (ten o nowej kłódce nic nie wie,
 * bo to czysto przeglądarkowy stan DOM — patrz komentarz przy wywołaniu w
 * routes/orders.js).
 *
 * ⚠️ Celowo NIE jest to gated przez `isGroupClientType` — `templates/order.njk`
 * pokazuje kłódkę i steruje `.price-row`/`.sub-params-row` warunkiem
 * `isGroup or isGroupShop` BEZ WZGLĘDU na typ grupy (`shop` też). Wcześniejsza
 * wersja wymagała `isGroupClientType` po stronie `routes/orders.js` do
 * odpalenia tej funkcji — jeśli ta flaga z jakiegoś powodu nie zgadzała się
 * z tym, co widać na ekranie, PDF cichcem wracał do STAREGO
 * `resolveSubPricePdfView` (inny mechanizm, inny toggle) i rozjeżdżał się
 * z ekranem dokładnie tak, jak się rozjechał (SUB zamiast katalogowych, VAT
 * nieprzefiltrowany). Jedyna część specyficzna dla `client` to rabat —
 * `isGroupClientType` wchodzi TYLKO do `showClientDiscount`.
 *
 * Reguły:
 * - grupa-matka + kłódka schowana    → tylko katalogowe (jak na ekranie),
 * - grupa-matka + kłódka odsłonięta  → katalogowe + SUB (+ rabat, jeśli `client`),
 * - konto podrzędne (`group_user`)   → NIGDY katalogowych; kłódka dokłada SUB
 *   locked (+ rabat, jeśli `client`).
 */
function resolveGroupClientPdfPriceView({ isGroupShop, discountUnlocked, isGroupClientType }) {
  const unlocked = !!discountUnlocked;
  return {
    // `clientView` ukrywa katalogowe (patrz `order_to_print.njk`/`order-pdf.njk`
    // `{% if not clientView %}`) — konto podrzędne ma je ukryte zawsze, grupa-
    // -matka widzi katalogowe zawsze (kłódka ich nigdy nie chowa na ekranie).
    clientView: !!isGroupShop,
    // `showBoth` DOKŁADA sub obok katalogowych — tylko grupie-matce po kłódce.
    showBoth: !isGroupShop && unlocked,
    // Rabat klienta grupy istnieje tylko dla `group_type = 'client'`
    // (`group_user.discount_percent`) — grupa `shop` nie ma czego odsłaniać.
    showClientDiscount: unlocked && !!isGroupClientType
  };
}

/**
 * VAT od ukrytej sumy klienta `subLocked` (netto po rabacie, suma
 * `SUB___WARTOSC_KONCOWA` pozycji) — wiersze „VAT 19%” i „Brutto Betrag inkl.
 * MwSt” pod sumą po rabacie (decyzja właściciela 2026-10-26).
 *
 * VAT liczony od SUMY zamówienia, a nie sumowany z zaokrąglonych VAT-ów
 * pozycji — tak jak na fakturze (`services/invoices/core/calculator.js`).
 *
 * @returns {{vat: string, gross: string}|null} kwoty z dwoma miejscami albo
 *   null, gdy nie ma stawki (VAT wyłączony) albo sumy.
 */
function computeVatTotals(net, vatRate) {
  const netValue = parseFloat(net);
  if (typeof vatRate !== 'number' || !Number.isFinite(vatRate)) return null;
  if (!Number.isFinite(netValue) || netValue === 0) return null;
  const vat = Math.round(netValue * vatRate) / 100;
  return { vat: vat.toFixed(2), gross: (netValue + vat).toFixed(2) };
}

/**
 * Grupa NIGDY nie widzi VAT-u cen klienta `SUB___` — ani grupa-matka
 * (`role = group`), ani jej konto podrzędne (`group_user`); ani na ekranie po
 * kłódce, ani w PDF/mailu (decyzje właściciela 2026-10-27). Zdejmuje stawkę
 * i kwoty z `attachSubVatTotals`, zanim trafią do szablonów i do
 * `buildPdfSendDataTotals` (`vatRate`). Wołać zaraz po nim. VAT cen zwykłych
 * matki (`attachRegularVatTotals`, przy „HKL Razem”) to osobny tor — zostaje.
 *
 * @param {object} totalPrice
 * @param {boolean} isGroupRole  `res.locals.isGroup || res.locals.isGroupShop`
 */
function dropSubVatForGroups(totalPrice, isGroupRole) {
  if (!totalPrice || !isGroupRole) return totalPrice;
  delete totalPrice.vatRate;
  delete totalPrice.subVat;
  delete totalPrice.subGross;
  return totalPrice;
}

/**
 * VAT CEN ZWYKŁYCH (P) — osobny tor, niezależny od VAT-u cen klienta `SUB___`
 * (`attachSubVatTotals` zostaje bez zmian). Decyzja właściciela 2026-10-27:
 * podstawą jest `SUMA_BRUTTO` — mimo nazwy to NETTO — czyli suma „HKL Razem”
 * (`totalPrice.visible` = SUM(`order_item.unit_price`), zapisywane z tego
 * parametru; pozycje grup bez `SUMA_BRUTTO` mają tam swoją cenę zwykłą).
 * Stopka: „HKL Razem: … netto”, „VAT x%: …”, „Kwota brutto z VAT x%: …”
 * (`partials/order_regular_vat_totals.njk`).
 *
 * @returns {Promise<object>} `totalPrice` z `regularVatRate`, `regularVat`, `regularGross`
 */
async function attachRegularVatTotals(totalPrice, orderId) {
  if (!totalPrice) return totalPrice;
  const { resolveRegularVatRateForOrder } = require('./vatCalculator');
  const { vatRate } = await resolveRegularVatRateForOrder(orderId);
  const totals = computeVatTotals(totalPrice.visible, vatRate);
  if (totals) {
    totalPrice.regularVatRate = vatRate;
    totalPrice.regularVat = totals.vat;
    totalPrice.regularGross = totals.gross;
  }
  return totalPrice;
}

/**
 * Dokłada do `totalPrice` stawkę i kwoty VAT ukrytej sumy klienta
 * (`vatRate`, `subVat`, `subGross` — patrz `computeVatTotals`). Stawka jak
 * w formularzu pozycji, ale dla WŁAŚCICIELA zlecenia
 * (`vatCalculator.resolveVatRateForOrder`).
 *
 * `totalPrice.subLocked` liczy wołający (`calcSubTotals`); bez niego zostaje
 * sama stawka — tak korzysta z niej wysyłka, gdzie sumy liczy
 * `buildPdfSendDataTotals`. Przy wyłączonym VAT-cie (`VAT_ENABLED`) nic nie
 * dokłada, więc szablony nie pokazują wierszy.
 */
async function attachSubVatTotals(totalPrice, orderId) {
  if (!totalPrice) return totalPrice;
  const { resolveVatRateForOrder } = require('./vatCalculator');
  const { vatRate, isGroup } = await resolveVatRateForOrder(orderId);
  if (typeof vatRate !== 'number') return totalPrice;
  totalPrice.vatRate = vatRate;
  // Zlecenie grupy (matka i konto podrzędne): VAT od sumy ZWYKŁEJ (P) — `hidden`
  // = SUM(order_item.total_price), a nie od ceny klienta (N, `subLocked`).
  // Decyzja właściciela 2026-10-27: dotyczy tylko sumy, nie parametrów.
  const vatBase = isGroup ? parseFloat(totalPrice.hidden) : totalPrice.subLocked;
  totalPrice.vatBase = vatBase;
  // Kolumna stopki (P/N) dla VAT-u w PDF-ie — `buildPdfSendDataTotals`.
  totalPrice.vatBaseIsRegular = !!isGroup;
  const sub = computeVatTotals(vatBase, vatRate);
  if (sub) {
    totalPrice.subVat = sub.vat;
    totalPrice.subGross = sub.gross;
  }
  return totalPrice;
}

/**
 * Złoty wiersz pozycji w podglądzie zlecenia GRUPY (matka i konto podrzędne),
 * odsłaniany kłódką „Pokaż cenę po rabacie”. Decyzja właściciela 2026-10-27:
 * przed kłódką ceny cennikowe (`SUB___`, przed rabatem), po kłódce tylko
 * procent rabatu nadany przez matkę i wartość netto po rabacie.
 *
 * Dopisuje `item.groupGoldValues` (`{key, display, value, locked}`) — schemat
 * właściciela z 2026-10-27 (rozbicie liczy `pricesCalculator.js
 * clientDiscountBreakdown`, tu tylko kolejność i etykiety):
 *  • `SUB___RABAT_KLIENTA` — procent rabatu matki: zapisany na pozycji, a gdy go
 *    nie ma (pozycje sprzed wpisu rabatu) — bieżący rabat konta `clientPct`;
 *    NIE cennikowy `SUB___CENA_RABAT` (to nie jest rabat matki);
 *  • `SUB___CENA_PO_RABACIE` — cena katalogowa po rabacie klienta, za sztukę;
 *  • `SUB___RABAT_DOPLATY` — rabat na dopłatę z konfiguratora (tylko z dopłatą);
 *  • `SUB___DOPLATA_EL_RABAT` — RABAT EL z cennika, pod własną nazwą (gdy > 0);
 *  • `SUB___DOPLATA_PO_RABACIE` — dopłata po rabacie, za sztukę (tylko z dopłatą);
 *  • `SUB___CENA_KONCOWA` — wartość 1 szt. po rabacie (cena + dopłata po rabacie);
 *  • `SUB___WARTOSC_KONCOWA` — wartość 1 szt. × ilość — NETTO (właściciel
 *    2026-10-27; etykieta `order.gross_after_discount_label` mimo nazwy klucza
 *    brzmi „Wartość netto po rabacie”).
 * Pozycje zapisane przed 2026-10-27 nie mają trzech wierszy rozbicia — do
 * ponownego zapisu/przeliczenia pokazują sam procent, wartość sztuki i wartość.
 * Wiersze VAT pozycji są pomijane — VAT jest tylko w sumie zlecenia.
 *
 * @param {Array} cleanOrderItems wynik `orderService.jsonTextBackToMap`
 * @param {{clientPct?: number, labels?: {percent?: string, unit?: string, surchargePercent?: string, surcharge?: string, unitValue?: string, gross?: string}}} [opts]
 */
function attachGroupGoldValues(cleanOrderItems, { clientPct = 0, labels = {} } = {}) {
  for (const table of cleanOrderItems || []) {
    for (const rowObj of table?.rows || []) {
      const item = rowObj?.item;
      if (!item) continue;
      const byKey = new Map((item.subParamValues || [])
        .filter((e) => e && e.value !== undefined && e.value !== null && e.value !== '' && e.value !== '-')
        .map((e) => [e.key, e]));

      const gold = [];
      const stored = byKey.get('SUB___RABAT_KLIENTA');
      if (stored) {
        gold.push({ ...stored, display: labels.percent || stored.display, locked: true });
      } else if (clientPct > 0) {
        gold.push({ key: 'SUB___RABAT_KLIENTA', display: labels.percent || '', value: `${clientPct}%`, locked: true });
      }
      const rows = [
        ['SUB___CENA_PO_RABACIE', labels.unit],
        ['SUB___RABAT_DOPLATY', labels.surchargePercent],
        // RABAT EL — parametr cennika (rabat na dopłatę elektryczną), z własną
        // nazwą z param.txt; tylko gdy coś obniża (właściciel 2026-10-27:
        // „rabat EL group usera nie wyświetla się, nawet jeżeli istnieje”).
        ['SUB___DOPLATA_EL_RABAT', null, (entry) => parseFloat(String(entry.value).replace(',', '.')) > 0],
        ['SUB___DOPLATA_PO_RABACIE', labels.surcharge],
        ['SUB___CENA_KONCOWA', labels.unitValue],
        ['SUB___WARTOSC_KONCOWA', labels.gross]
      ];
      for (const [key, label, shown = () => true] of rows) {
        const entry = byKey.get(key);
        if (entry && shown(entry)) gold.push({ ...entry, display: label || entry.display, locked: true });
      }
      item.groupGoldValues = gold;
    }
  }
  return cleanOrderItems;
}

/**
 * Buduje etykietowane totale do PDF / maila — ta sama logika co na stronie zamówienia.
 * `currency` — waluta klienta zamówienia (services/currency.js); brak = EUR („…€”).
 * `withSubTotal` — przy `showBoth` (w dokumencie ceny zwykłe I SUB___) dokłada
 * `total_sub` = suma SUB___, tak jak stopka zlecenia (zgłoszenie 2026-10-09).
 * Wołający nie-grupowi podają `true`; grupy mają własną stopkę (Changelog 2026-08-24).
 * Suma widoczna cen klienta (`SUB___`) ma etykietę `order.total_list_gross`
 * („GESAMTBETRAG LISTENPREIS BRUTTO”), a `total_is_sub` mówi szablonowi, która
 * etykieta siedzi w `total`.
 * `vatRate` (z `attachSubVatTotals`; null = bez VAT-u, np. konto podrzędne
 * grupy) dokłada pod `total_hidden` sum klienta `total_vat` i `total_gross`.
 */
function buildPdfSendDataTotals({
  isClientView,
  showBoth,
  orderItems,
  totalPrice,
  translate,
  showGoldPrices = true,
  currency,
  withSubTotal = false,
  vatRate = null
}) {
  const __ = translate || ((key) => key);
  const kwota = (value) => formatAmount(value, currency);
  // Baza VAT sumy: `vatBase` z `attachSubVatTotals` (zlecenie grupy = suma zwykła),
  // a bez niego — ukryta suma klienta jak dawniej.
  const vatBase = totalPrice?.vatBase ?? calcSubTotals(orderItems).subLocked;
  const vatRows = () => {
    const totals = computeVatTotals(vatBase, vatRate);
    if (!totals) return {};
    return {
      // Stopka PDF w dwóch kolumnach (2026-10-27): VAT grupy liczony od cen
      // zwykłych idzie do kolumny P, reszta — do kolumny cen klienta N.
      total_vat_is_regular: !!totalPrice?.vatBaseIsRegular,
      total_vat: `${__('order.total_vat')} ${vatRate}%: ${kwota(totals.vat)}`,
      total_gross: `${__('order.total_gross_incl_vat')}${vatRate}%: ${kwota(totals.gross)}`
    };
  };

  if (isClientView) {
    const subTotals = calcSubTotals(orderItems);
    const hasHidden = subTotals.subLocked && subTotals.subLocked !== 0;
    return {
      total: subTotals.subVisible && subTotals.subVisible !== 0
        ? `${__('order.total_list_gross')}: ${kwota(subTotals.subVisible)}` : null,
      total_is_sub: true,
      total_hidden_is_sub: true,
      total_hidden: hasHidden
        ? `${__('order.total_hidden')}: ${kwota(subTotals.subLocked)} netto` : null,
      ...vatRows()
    };
  }

  if (showBoth) {
    const subTotals = calcSubTotals(orderItems);
    const hasHidden = subTotals.subLocked && subTotals.subLocked !== 0;
    const result = {
      total: totalPrice?.visible && Number(totalPrice.visible) !== 0
        ? `${__('order.total')}: ${kwota(totalPrice.visible)}` : null,
      total_hidden_is_sub: true,
      total_hidden: hasHidden
        ? `${__('order.total_hidden')}: ${kwota(subTotals.subLocked)} netto` : null,
      ...vatRows()
    };
    if (withSubTotal && subTotals.subVisible && subTotals.subVisible !== 0) {
      result.total_sub = `${__('order.total_list_gross')}: ${kwota(subTotals.subVisible)}`;
    }
    return result;
  }

  const result = { total: null, total_hidden: null };
  if (totalPrice?.visible && Number(totalPrice.visible) !== 0) {
    result.total = `${__('order.total')}: ${kwota(totalPrice.visible)}`;
  }
  if (showGoldPrices) {
    if (totalPrice?.hidden && Number(totalPrice.hidden) !== 0) {
      result.total_hidden = `${__('order.total_hidden')}: ${kwota(totalPrice.hidden)} netto`;
    } else if (totalPrice?.visible && Number(totalPrice.visible) !== 0) {
      result.total_hidden = `${__('order.total_hidden')}: ${kwota(totalPrice.visible)} netto`;
    }
  }
  return result;
}

module.exports = {
  HKL_ORG_ID,
  orderHasSubPrices,
  calcSubTotals,
  calcClientDiscountTotal,
  resolveClientDiscountSummary,
  resolveItemClientDiscount,
  resolveDiscountBaseTotal,
  resolveSubPricePdfView,
  resolveGroupClientPdfPriceView,
  buildPdfSendDataTotals,
  computeVatTotals,
  attachSubVatTotals,
  attachRegularVatTotals,
  dropSubVatForGroups,
  attachGroupGoldValues
};
