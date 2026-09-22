/**
 * Aggregates per-group findings into one run report, in the shape the PDF
 * brief asks for (sekcja 3): per-finding model/group, expected vs actual,
 * price diff, message, date, version — plus a summary for the email subject.
 */

'use strict';

function buildRunReport(groupResults, { startedAt, finishedAt } = {}) {
  const findings = [];
  const skippedGroups = [];
  // Per-group breakdown so the report (and the e-mail) says WHICH groups were
  // covered, not just how many — "sprawdzono 15 grup" alone tells a reader
  // nothing about whether their own product line was tested.
  const groups = [];
  for (const gr of groupResults) {
    groups.push({
      groupNumber: gr.groupNumber,
      skipped: !!gr.skipped,
      findings: (gr.findings || []).length,
      byPriority: (gr.findings || []).reduce((acc, f) => {
        acc[f.priority] = (acc[f.priority] || 0) + 1;
        return acc;
      }, {}),
      positionsChecked: gr.positionsChecked,
      positionsTotal: gr.positionsTotal,
      stats: gr.stats,
      reason: gr.reason
    });
    if (gr.skipped) {
      skippedGroups.push({ groupNumber: gr.groupNumber, reason: gr.reason });
      continue;
    }
    findings.push(...(gr.findings || []));
  }

  // The same defect surfaced twice per position (once for CENA, once for
  // SUB___CENA, with identical numbers), doubling every count in the e-mail.
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const key = [f.code, f.priority, f.groupNumber, f.positionId, f.expected, f.actual].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  findings.length = 0;
  findings.push(...deduped);

  const byPriority = { P1: 0, HIGH: 0, MEDIUM: 0 };
  for (const f of findings) {
    byPriority[f.priority] = (byPriority[f.priority] || 0) + 1;
  }

  const totals = groups.reduce((acc, g) => {
    const st = g.stats || {};
    acc.positionsChecked += g.positionsChecked || 0;
    acc.positionsTotal += g.positionsTotal || 0;
    acc.comparedToPriceList += st.comparedToPriceList || 0;
    acc.comparedToStored += st.comparedToStored || 0;
    acc.cartChecked += st.cartChecked || 0;
    acc.scriptsRun += st.scriptsRun || 0;
    acc.duplicates += st.duplicates || 0;
    acc.rangeCases += st.rangeCases || 0;
    acc.rangeInRange += st.rangeInRange || 0;
    acc.rangeOutOfRange += st.rangeOutOfRange || 0;
    acc.rangeOptionCases += st.rangeOptionCases || 0;
    acc.positionsInDb += st.positionsInDb || 0;
    acc.failed += st.failed || 0;
    acc.missingRules += st.missingRules || 0;
    // Warstwy pseudo-grupowe: symulacja tworzenia pozycji i parsowanie skryptów.
    acc.simulated += st.simulated || 0;
    acc.simulationPassed += st.simulationPassed || 0;
    acc.scriptsParsed += st.scriptsParsed || 0;
    acc.scriptsBroken += st.scriptsBroken || 0;
    return acc;
  }, { positionsChecked: 0, positionsTotal: 0, comparedToPriceList: 0, comparedToStored: 0, cartChecked: 0, scriptsRun: 0, duplicates: 0, positionsInDb: 0, rangeCases: 0, rangeInRange: 0, rangeOutOfRange: 0, rangeOptionCases: 0, failed: 0, missingRules: 0, simulated: 0, simulationPassed: 0, scriptsParsed: 0, scriptsBroken: 0 });

  return {
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: finishedAt || new Date().toISOString(),
    totals,
    groupsChecked: groupResults.length - skippedGroups.length,
    groupsSkipped: skippedGroups,
    groups,
    totalFindings: findings.length,
    byPriority,
    findings
  };
}

module.exports = { buildRunReport };
