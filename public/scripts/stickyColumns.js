/*
 * Freezes the first three columns of the horizontally scrollable order table.
 * Left offsets for sticky columns are computed here because column widths are
 * dynamic and cannot be known at CSS authoring time.
 *
 * Detail rows (.price-row, .sub-params-row, .prod-time-row …) use
 * `position: sticky; left: 0` directly on their <td> elements (see CSS).
 */
(function () {
  'use strict';

  // ── Frozen column offsets ─────────────────────────────────────────────────

  function computeOffsets(table) {
    var headRow = table.querySelector('thead tr');
    if (!headRow) return;

    var cells = headRow.children;
    if (cells.length < 3) return;

    // ⚠️ `getBoundingClientRect().width`, NIE `offsetWidth`: kolumny mają
    // szerokości UŁAMKOWE (np. 185.37 px), a `offsetWidth` zwraca zaokrągloną
    // liczbę całkowitą (185). Przypięta kolumna lądowała wtedy o ułamek piksela
    // za blisko albo za daleko — między pierwszą a drugą kolumną prześwitywała
    // cienka szczelina, przez którą było widać przewijaną treść.
    var width1 = cells[0].getBoundingClientRect().width;
    var width2 = cells[1].getBoundingClientRect().width;

    table.style.setProperty('--sticky-left-1', '0px');
    table.style.setProperty('--sticky-left-2', width1 + 'px');
    table.style.setProperty('--sticky-left-3', (width1 + width2) + 'px');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    var tables = document.querySelectorAll('.order-table');
    if (!tables.length) return;

    tables.forEach(function (table) {
      computeOffsets(table);

      if (typeof ResizeObserver !== 'undefined') {
        var observer = new ResizeObserver(function () {
          computeOffsets(table);
        });
        observer.observe(table);
      }
    });

    window.addEventListener('resize', function () {
      tables.forEach(computeOffsets);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
