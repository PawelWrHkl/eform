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
      reason: gr.reason
    });
    if (gr.skipped) {
      skippedGroups.push({ groupNumber: gr.groupNumber, reason: gr.reason });
      continue;
    }
    findings.push(...(gr.findings || []));
  }

  const byPriority = { P1: 0, HIGH: 0, MEDIUM: 0 };
  for (const f of findings) {
    byPriority[f.priority] = (byPriority[f.priority] || 0) + 1;
  }

  return {
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: finishedAt || new Date().toISOString(),
    groupsChecked: groupResults.length - skippedGroups.length,
    groupsSkipped: skippedGroups,
    groups,
    totalFindings: findings.length,
    byPriority,
    findings
  };
}

module.exports = { buildRunReport };
