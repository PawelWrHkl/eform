/**
 * Aggregates per-group findings into one run report, in the shape the PDF
 * brief asks for (sekcja 3): per-finding model/group, expected vs actual,
 * price diff, message, date, version — plus a summary for the email subject.
 */

'use strict';

function buildRunReport(groupResults, { startedAt, finishedAt } = {}) {
  const findings = [];
  const skippedGroups = [];
  for (const gr of groupResults) {
    if (gr.skipped) {
      skippedGroups.push({ groupNumber: gr.groupNumber, reason: gr.reason });
      continue;
    }
    findings.push(...gr.findings);
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
    totalFindings: findings.length,
    byPriority,
    findings
  };
}

module.exports = { buildRunReport };
