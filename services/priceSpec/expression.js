'use strict';

/**
 * Wyrażenie specyfikacji ceny `<PARAM>_S` — budują je skrypty cennika
 * (`param-CENA-*.js`, `param-DOPLATA-*.js`, …): dla każdego składnika ceny
 * dopisują `kwota(KOD)`, a na końcu, gdy klient ma indywidualny czynnik,
 * opakowują całość w `(…)*czynnik`.
 *
 * Kształty spotykane w bazie (3000 ostatnich pozycji, 2026-10-16):
 *   `267(PLISOWANE)`                         — jeden składnik
 *   `(42.06(SCHIENE89))*1.035`               — z czynnikiem klienta
 *   `(195(RRLKV2)+127(PG1))*1.035`           — kilka składników
 *   `469(M67)+20(P01)+34(R02)+216(A07)`      — bez czynnika
 *   `(55(A)+-12(B))*1.1`                     — składnik ujemny
 *   `()*1.035`                               — brak składników (np. brak dopłat)
 *   `0.6(VALUE)`                             — rabat (ułamek), nie kwota
 *
 * ⚠️ Czynniki NIE są tu po to, żeby je pokazać — specyfikacja dla klienta
 * nigdy ich nie zdradza (patrz `allocateToTotal`). Parser przenosi je na
 * KAŻDY składnik osobno (`(25(SF)+86(ELMONO))*1.04` → 26 i 89.44), a nie na
 * sumę rozbijaną potem proporcją.
 */

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/gy;

function tokenize(text) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < text.length && (m = TOKEN_RE.exec(text))) {
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: 'id', value: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: 'op', value: m[3] });
  }
  return tokens;
}

/**
 * Wynik węzła: kombinacja liniowa składników `{ terms: [{code, amount}], constant }`.
 * Wyrażenia cennika są liniowe w składnikach (suma × czynnik); iloczyn dwóch
 * wyrażeń ze składnikami nie występuje — gdyby się pojawił, parser zgłasza
 * `nonlinear`, a wołający pokazuje kwotę bez rozbicia.
 */
function lin(terms = [], constant = 0) {
  return { terms, constant };
}

function scale(node, k) {
  return lin(node.terms.map((t) => ({ code: t.code, amount: t.amount * k })), node.constant * k);
}

function add(a, b, sign = 1) {
  const bb = sign === 1 ? b : scale(b, -1);
  return lin([...a.terms, ...bb.terms], a.constant + bb.constant);
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(value) {
    const t = this.tokens[this.pos];
    return t && (value === undefined || t.value === value) ? t : null;
  }

  take(value) {
    const t = this.peek(value);
    if (!t) throw new Error(`oczekiwano „${value}"`);
    this.pos++;
    return t;
  }

  // expr := term (('+' | '-') term)*   — także „+-" (dodanie ujemnego składnika)
  expr() {
    if (this.peek(')')) return lin(); // `()` — pusta suma
    let node = this.term();
    while (this.peek('+') || this.peek('-')) {
      const sign = this.take(this.tokens[this.pos].value).value === '-' ? -1 : 1;
      node = add(node, this.term(), sign);
    }
    return node;
  }

  // term := unary (('*' | '/') unary)*
  term() {
    let node = this.unary();
    while (this.peek('*') || this.peek('/')) {
      const op = this.take(this.tokens[this.pos].value).value;
      const right = this.unary();
      const leftConst = node.terms.length === 0;
      const rightConst = right.terms.length === 0;
      if (op === '*') {
        if (rightConst) node = scale(node, right.constant);
        else if (leftConst) node = scale(right, node.constant);
        else throw Object.assign(new Error('iloczyn składników'), { nonlinear: true });
      } else {
        if (!rightConst || right.constant === 0) throw Object.assign(new Error('dzielenie przez składnik'), { nonlinear: true });
        node = scale(node, 1 / right.constant);
      }
    }
    return node;
  }

  // unary := ('-' | '+')? primary
  unary() {
    if (this.peek('-')) { this.take('-'); return scale(this.unary(), -1); }
    if (this.peek('+')) { this.take('+'); return this.unary(); }
    return this.primary();
  }

  // primary := NUM '(' ID ')'  |  NUM  |  '(' expr ')'
  primary() {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('niespodziewany koniec');
    if (t.type === 'num') {
      this.pos++;
      // `kwota(KOD)` — kod w nawiasie przypięty do liczby
      const open = this.peek('(');
      const id = open && this.tokens[this.pos + 1];
      const close = id && this.tokens[this.pos + 2];
      if (open && id && id.type === 'id' && close && close.value === ')') {
        this.pos += 3;
        return lin([{ code: id.value, amount: t.value }]);
      }
      return lin([], t.value);
    }
    if (t.value === '(') {
      this.take('(');
      const node = this.expr();
      this.take(')');
      return node;
    }
    throw new Error(`niespodziewany znak „${t.value}"`);
  }
}

/**
 * @param {string} raw  wartość `<PARAM>_S`
 * @returns {{ items: Array<{code: string, amount: number}>, constant: number,
 *   isFraction: boolean, ok: boolean }}
 *   `items` — składniki z przeniesionymi czynnikami (kolejność jak w skrypcie,
 *   powtórzony kod zsumowany); `isFraction` — `x(VALUE)`, czyli rabat, nie kwota;
 *   `ok: false` — wyrażenia nie dało się bezpiecznie rozebrać.
 */
function parseSpecExpression(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (!text) return { items: [], constant: 0, isFraction: false, ok: true };
  try {
    const parser = new Parser(tokenize(text));
    const node = parser.expr();
    if (parser.pos !== parser.tokens.length) throw new Error('nadmiarowe znaki');
    const merged = new Map();
    for (const t of node.terms) {
      if (!Number.isFinite(t.amount)) throw new Error('kwota nie jest liczbą');
      merged.set(t.code, (merged.get(t.code) || 0) + t.amount);
    }
    const items = [...merged].map(([code, amount]) => ({ code, amount }));
    const isFraction = items.length > 0 && items.every((i) => i.code.toUpperCase() === 'VALUE');
    return { items: isFraction ? [] : items.filter((i) => i.code.toUpperCase() !== 'VALUE'), constant: node.constant, isFraction, ok: true };
  } catch (_err) {
    return { items: [], constant: 0, isFraction: false, ok: false };
  }
}

const isWhole = (n) => Math.abs(n - Math.round(n)) < 0.005;

/**
 * Rozkłada `total` (kwotę, którą użytkownik WIDZI w zleceniu) na składniki
 * `_S` — z sumą dokładnie równą `total`.
 *
 * ⚠️ KAŻDY SKŁADNIK OSOBNO × CZYNNIK (polecenie właściciela 2026-10-27).
 * Parser już przeniósł czynnik `_S` na składniki: `(25(SF)+86(ELMONO))*1.04`
 * → SF 26, ELMONO 89.44. Skrypt cennika kończy się `toFixed(fr)` na SUMIE
 * (`fr = 0` — ceny klienta w pełnych euro: 115.44 → 115), więc kwota widoczna
 * różni się od sumy składników tylko zaokrągleniem — składnik zaokrąglamy
 * z tą samą dokładnością co cennik: SF 26 + ELMONO 89 = 115. Do 2026-10-27
 * widoczne 115 szło proporcją (115 × 26/115.44 = 25.90 i 89.10) — fałszywe
 * kwoty, jakich nie ma żaden cennik.
 *
 * Proporcja zostaje tylko dla czynników SPOZA `_S`: wariant skryptu
 * (`param-DOPLATA-Cmul1.1.js` → `DOPLATA*1.1`, w `_S` go nie ma), narzut grupy
 * (`applyClientMarkup`), mnożnik pracownika (`priceFactor`). Tam kwota widoczna
 * odbiega od sumy o więcej niż zaokrąglenie i skalowanie do niej sprawia, że
 * żaden mnożnik nie pojawia się w specyfikacji ani nie da się go odczytać
 * z różnicy „suma składników ≠ cena".
 *
 * Dokładność: pełne euro, gdy kwota jest okrągła, a suma składników nie (ślad
 * `toFixed(0)`), inaczej grosze. Końcówkę rozdziela metoda największej reszty
 * (Hamiltona): każdy składnik w dół do jednostki, brakujące jednostki trafiają
 * do składników o największej odciętej części (nadmiarowe schodzą z tych
 * o najmniejszej) — stabilnie i bez „magicznej" poprawki na ostatnim wierszu.
 *
 * @param {Array<{amount: number}>} items  kwoty z czynnikiem `_S` (parser)
 * @param {number} total
 * @returns {number[]|null} kwoty w tej samej kolejności co `items`; `null`, gdy
 *   proporcji nie da się ustalić (brak składników albo ich suma ≤ 0).
 */
function allocateToTotal(items, total) {
  if (!Array.isArray(items) || items.length === 0 || !Number.isFinite(total)) return null;
  const sum = items.reduce((s, i) => s + i.amount, 0);
  if (!(sum > 0)) return null;
  const unitCents = isWhole(total) && !isWhole(sum) ? 100 : 1;
  const totalUnits = Math.round(Math.round(total * 100) / unitCents);
  const sumUnits = (sum * 100) / unitCents;
  // Różnica w granicach zaokrąglenia → składnik × czynnik bez zmian; większa → ukryty czynnik.
  const scale = Math.abs(totalUnits - sumUnits) <= 0.5 * items.length + 1e-6 ? 1 : totalUnits / sumUnits;
  const exact = items.map((i) => Math.round(((i.amount * 100) / unitCents) * scale * 1e6) / 1e6);
  const units = exact.map((x) => Math.floor(x));
  let remaining = totalUnits - units.reduce((s, x) => s + x, 0);
  const byFrac = exact.map((x, idx) => ({ idx, frac: x - Math.floor(x) }));
  if (remaining > 0) {
    byFrac.sort((a, b) => b.frac - a.frac || a.idx - b.idx);
    for (let k = 0; remaining > 0; k = (k + 1) % byFrac.length, remaining--) units[byFrac[k].idx] += 1;
  } else if (remaining < 0) {
    byFrac.sort((a, b) => a.frac - b.frac || b.idx - a.idx);
    for (let k = 0; remaining < 0; k = (k + 1) % byFrac.length, remaining++) units[byFrac[k].idx] -= 1;
  }
  return units.map((u) => (u * unitCents) / 100);
}

module.exports = { parseSpecExpression, allocateToTotal };
