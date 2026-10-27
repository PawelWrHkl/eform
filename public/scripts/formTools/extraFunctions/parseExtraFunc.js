/**
 * Parser komórki `EXTRAFUNC` z `param.txt`.
 *
 * Składnia (przecinek rozdziela funkcje, w nawiasie opcje `klucz=wartość`
 * rozdzielone `|` — ta sama para separatorów co `<PARAM>_ATTRS` w paramdict):
 *
 *   popup-input
 *   popup-input(unit=cm|min=10|max=500)
 *   popup-input(label=Długość sznurka|info=Mierzone od dołu, z zapasem), inna-funkcja
 *
 * Przecinek WEWNĄTRZ nawiasu należy do wartości opcji (np. tekst `info`), nie
 * rozdziela funkcji. `<NULL>`/pusta komórka/brak kolumny (starsze wersje
 * reguł) → `[]`.
 *
 * @param {string|null|undefined} cell
 * @returns {{name: string, options: Object<string, string>}[]}
 */
export function parseExtraFuncCell(cell) {
    if (typeof cell !== 'string') return [];
    const text = cell.replace(/\r/g, '').trim();
    if (text === '' || text === '<NULL>') return [];

    return splitTopLevel(text)
        .map(parseSpec)
        .filter(Boolean);
}

function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts.map(p => p.trim()).filter(Boolean);
}

function parseSpec(spec) {
    const match = spec.match(/^([A-Za-z0-9_-]+)\s*(?:\((.*)\))?$/s);
    if (!match) {
        console.warn(`EXTRAFUNC: nie rozumiem zapisu „${spec}" — pomijam.`);
        return null;
    }
    const [, name, rawOptions] = match;
    return { name: name.toLowerCase(), options: parseOptions(rawOptions) };
}

function parseOptions(raw) {
    const options = {};
    if (!raw) return options;
    for (const pair of raw.split('|')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const key = pair.slice(0, eq).trim().toLowerCase();
        const value = pair.slice(eq + 1).trim();
        if (key) options[key] = value;
    }
    return options;
}
