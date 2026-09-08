/**
 * Runs one group's suite in a child process and brings the result back.
 *
 * See scripts/configTestGroupWorker.js for why: memory. Set
 * CONFIGTEST_ISOLATE_GROUPS=false to run everything in-process instead (useful
 * when debugging, since stack traces stay in one place).
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./logger');

// Defined HERE, not imported from the worker script: requiring that script
// executes it, so pulling the constant across started a worker with no
// arguments, which promptly called process.exit(2) and killed the parent run.
const RESULT_MARKER = '__CONFIGTEST_RESULT__';

const ISOLATE_GROUPS = String(process.env.CONFIGTEST_ISOLATE_GROUPS).toLowerCase() !== 'false';
const WORKER = path.join(__dirname, '..', '..', 'scripts', 'configTestGroupWorker.js');
const GROUP_TIMEOUT_MS = Number(process.env.CONFIGTEST_GROUP_TIMEOUT_MS) || 15 * 60 * 1000;

function runGroupInChild(groupNumber, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=2048', WORKER, String(groupNumber), JSON.stringify(opts)],
      { cwd: path.join(__dirname, '..', '..'), env: process.env }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    // A hung group must not stall the whole night.
    const killTimer = setTimeout(() => {
      log(`ConfiguratorTester: grupa ${groupNumber} przekroczyła limit czasu — proces zatrzymany`);
      child.kill('SIGKILL');
    }, GROUP_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(killTimer);

      const markerAt = stdout.lastIndexOf(RESULT_MARKER);
      if (markerAt !== -1) {
        try {
          return resolve(JSON.parse(stdout.slice(markerAt + RESULT_MARKER.length).trim()));
        } catch (err) {
          log(`ConfiguratorTester: grupa ${groupNumber} — nie udało się odczytać wyniku: ${err.message}`);
        }
      }

      // No parseable result: report it instead of silently counting the group
      // as clean, which would be the dangerous failure mode.
      resolve({
        groupNumber,
        skipped: false,
        positionsChecked: 0,
        reason: `Proces testujący grupę zakończył się kodem ${code} bez wyniku.`,
        findings: [{
          priority: 'P1',
          code: 'GRUPA_NIESPRAWDZONA',
          groupNumber,
          positionId: null,
          message: `Grupa ${groupNumber} nie została sprawdzona — proces zakończył się kodem ${code}. ${(stderr.trim().split('\n').pop() || '').slice(0, 300)}`,
          date: new Date().toISOString()
        }]
      });
    });
  });
}

module.exports = { runGroupInChild, ISOLATE_GROUPS, RESULT_MARKER };
