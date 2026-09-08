/**
 * Computes the reference price straight from the authoring workbook in
 * /mnt/eformconf, mirroring EXACTLY the semantics the generated
 * `param-<PARAM>-<LETTER>.js` scripts use.
 *
 * Those generated scripts are the ground truth for the ALGORITHM (they are the
 * output of the same compilation step this module reimplements from the source
 * spreadsheet), and reading one settled every open question:
 *
 *   for each section S (PGE, PG0…, AO40PGE…, TCND…):
 *       n = cond1(S) + cond2(S)        // primary fabric + secondary fabric
 *       x = SZEROKOSC/10 ; y = WYSOKOSC/10          (centimetres)
 *       v = S's table value, CEILING-bucketed: first x-bucket with x <= bound,
 *           then first y-bucket with y <= bound       ← NOT interpolation
 *       S_value = v * n
 *   price = (Σ S_value) * mul                        // mul from the script name
 *
 * `n` being a count (not a boolean) is how double-fabric products charge the
 * same price group twice; several sections matching at once is normal and
 * additive, NOT an ambiguity.
 *
 * The per-uid surcharge factor `f` that the generated scripts apply last
 * (`CENA = CENA * f`, e.g. +0.03 for specific clients) is deliberately NOT
 * modelled here — it is keyed by md5-hashed uid inside the built artifact, not
 * present in the workbook. Callers must treat a difference of exactly such a
 * factor as "client surcharge", not as a pricing bug.
 */

'use strict';

/** First bucket whose bound is >= value (the generated scripts' `if (x<=bound)` chain). */
function ceilingBucket(entries, value, keyOf) {
  let chosen = null;
  for (const entry of entries) {
    const bound = keyOf(entry);
    if (value <= bound && (chosen === null || bound < keyOf(chosen))) chosen = entry;
  }
  return chosen;
}

/**
 * Value of one section's table for the given dimensions.
 * @returns {{value:number, widthBound:number, heightBound:number}|{value:null, reason:string}}
 */
/**
 * Numeric content of one cell: a literal, or a formula evaluated by the
 * engine's own evaluator. Surcharges are frequently defined relatively, e.g.
 * `ROUND(CENA*0.1,2)`, and the generated scripts evaluate that same string —
 * so a formula cell is real data here, unlike the cached `.result` values the
 * parser filters out.
 */
function resolveCell(sheet, row, col, evaluateNumber) {
  const literal = sheet.valueAt(row, col);
  if (literal !== null) return { value: literal };

  const formula = sheet.formulaAt ? sheet.formulaAt(row, col) : null;
  if (!formula) return { value: null };
  if (typeof evaluateNumber !== 'function') {
    return { value: null, reason: `komórka jest formułą (${formula}), a nie podano ewaluatora` };
  }

  const evaluated = evaluateNumber(formula);
  if (!Number.isFinite(evaluated)) {
    return { value: null, reason: `nie udało się policzyć formuły komórki: ${formula}` };
  }
  return { value: evaluated, formula };
}

/**
 * Coordinates for ONE section, from the axis formulas it declares itself
 * (`Os-x`/`Os-y`). They are usually SZEROKOSC/10 and WYSOKOSC/10, but not
 * always — group 73 indexes by `SZEROKOSC_POTRZEBNA/10`, and reading width
 * instead landed on a completely different cell.
 *
 * A declared axis formula that will not evaluate to a number returns `null`,
 * NOT the plain dimension. Falling back used to look harmless and was the
 * single worst source of false alarms this tester produced: group 73's
 * `SZEROKOSC_POTRZEBNA` is undefined for MODEL=FLEX in a headless recompute, so
 * the fallback priced position #6376 at width 200 cm (80.78) while the deployed
 * script priced the same values at its own coordinate (42.34) — reported as 14
 * P1 "CENA_ZANIZONA". In the real browser that position settles the axis at
 * 4120 and workbook, script and screen all agree on 166.61. Not knowing the
 * coordinate has to mean "no reference", never "use a different one".
 */
function sectionAxes(section, widthCm, heightCm, evaluateNumber) {
  const evaluate = (formula, fallback) => {
    if (!formula) return fallback;
    if (typeof evaluateNumber !== 'function') return null;
    const value = evaluateNumber(formula);
    return Number.isFinite(value) ? value : null;
  };
  return {
    x: evaluate(section.axisX, widthCm),
    y: evaluate(section.axisY, heightCm)
  };
}

function sectionValue(sheet, block, section, widthCm, heightCm, evaluateNumber) {
  // Shape is decided PER SECTION, PER BLOCK by excelParser.classifySection() —
  // one sheet mixes flat surcharges, width-only tables and full width×height
  // grids.
  const shape = (section.shapeByBlock && section.shapeByBlock[block.letter]) || { kind: 'scalar', widths: [] };

  if (shape.kind === 'scalar') {
    const cell = resolveCell(sheet, section.headerRow, block.startCol, evaluateNumber);
    if (cell.value === null) {
      // An empty cell for this client's block means "this section adds nothing
      // for this variant" — the compiled scripts start every section at v = 0.
      return { value: 0, widthBound: null, heightBound: null, empty: !cell.reason, reason: cell.reason };
    }
    return { value: cell.value, widthBound: null, heightBound: null, formula: cell.formula };
  }

  const axes = sectionAxes(section, widthCm, heightCm, evaluateNumber);
  if (axes.x === null) {
    return { value: null, reason: `nie da się ustalić osi X sekcji ${section.label} (formuła ${section.axisX}) dla tej konfiguracji` };
  }
  if (shape.kind === 'grid2d' && axes.y === null) {
    return { value: null, reason: `nie da się ustalić osi Y sekcji ${section.label} (formuła ${section.axisY}) dla tej konfiguracji` };
  }

  const widthEntry = ceilingBucket(shape.widths, axes.x, (w) => w.widthCm);
  if (!widthEntry) {
    const max = shape.widths[shape.widths.length - 1].widthCm;
    return { value: null, reason: `wartość osi X ${axes.x} powyżej zakresu tabeli (max ${max}, sekcja ${section.label})` };
  }

  let row;
  let heightBound = null;
  if (shape.kind === 'grid1d') {
    // No height axis at all — the surcharge depends on width only.
    row = shape.dataRow;
    if (!row) return { value: null, reason: `sekcja ${section.label} nie ma wiersza danych w bloku ${block.letter}` };
  } else {
    const heightEntry = ceilingBucket(shape.heightRows, axes.y, (h) => h.heightCm);
    if (!heightEntry) {
      const max = shape.heightRows.length ? shape.heightRows[shape.heightRows.length - 1].heightCm : null;
      return { value: null, reason: `wartość osi Y ${axes.y} powyżej zakresu tabeli (max ${max}, sekcja ${section.label})` };
    }
    row = heightEntry.row;
    heightBound = heightEntry.heightCm;
  }

  const cell = resolveCell(sheet, row, widthEntry.col, evaluateNumber);
  if (cell.value === null) {
    return { value: null, reason: cell.reason || `brak liczby w komórce (sekcja ${section.label}, ${widthEntry.widthCm}cm)` };
  }
  return { value: cell.value, widthBound: widthEntry.widthCm, heightBound, formula: cell.formula };
}

/**
 * @param {object} opts
 * @param {object} opts.sheet              parsePriceSheet() result
 * @param {string} opts.letter             block letter from the client's script name
 * @param {number} [opts.multiplier]       `mul` factor from that same name
 * @param {number} opts.widthMm
 * @param {number} opts.heightMm
 * @param {(formula:string)=>boolean} opts.evaluateCondition  backed by the engine's
 *   real window.FormulaHandler.evaluateFormula
 * @returns {{found:true, price:number, contributions:Array, gaps:Array}|{found:false, reason:string}}
 */
function computePrice({ sheet, letter, multiplier = 1, widthMm, heightMm, evaluateCondition, evaluateNumber }) {
  const block = sheet.blocks.find((b) => b.letter === letter);
  if (!block) return { found: false, reason: `arkusz nie ma bloku ${letter}` };

  const widthCm = widthMm / 10;
  const heightCm = heightMm / 10;

  let total = 0;
  const contributions = [];
  const gaps = [];

  for (const section of sheet.sections) {
    if (!section.conditions.length) continue;

    let n = 0;
    for (const condition of section.conditions) {
      if (evaluateCondition(condition)) n += 1;
    }
    if (n === 0) continue;

    const resolved = sectionValue(sheet, block, section, widthCm, heightCm, evaluateNumber);
    if (resolved.value === null) {
      gaps.push({ section: section.label, multiplicity: n, reason: resolved.reason });
      continue;
    }

    total += resolved.value * n;
    contributions.push({
      section: section.label,
      multiplicity: n,
      value: resolved.value,
      widthBound: resolved.widthBound,
      heightBound: resolved.heightBound,
      ...(resolved.formula ? { formula: resolved.formula } : {}),
      ...(resolved.empty ? { empty: true } : {})
    });
  }

  if (contributions.length === 0) {
    // "We could not work out WHERE to look" is a different statement from "the
    // price list has nothing here", and only the latter says anything about the
    // configurator. Keep them apart so the assertion layer can refuse to make
    // a price claim on the first (see sectionAxes).
    const axisUnknown = gaps.length > 0 && gaps.every((g) => /nie da się ustalić osi/.test(g.reason || ''));
    return {
      found: false,
      ...(axisUnknown ? { kind: 'unknown-axis' } : {}),
      reason: gaps.length
        ? `pasujące sekcje nie mają danych dla tych wymiarów: ${gaps.map((g) => g.reason).join('; ')}`
        : 'żadna sekcja cennika nie pasuje do tej konfiguracji'
    };
  }

  // A contribution computed from a cell FORMULA (e.g. `ROUND(CENA*0.1,2)`)
  // is only as exact as the values it reads back out of the configuration.
  // Verified on real orders: the engine evaluates such a surcharge against the
  // base price BEFORE the per-uid factor `f` it applies at the very end, so the
  // reference lands a few percent off through no fault of the price list. Flag
  // it so the assertion layer can refrain from raising a P1 on derived values.
  const derived = contributions.some((c) => c.formula);

  return {
    found: true,
    price: parseFloat((total * multiplier).toFixed(2)),
    derived,
    letter,
    multiplier,
    widthCm,
    heightCm,
    contributions,
    gaps
  };
}

module.exports = { computePrice, ceilingBucket, sectionValue, sectionAxes };
