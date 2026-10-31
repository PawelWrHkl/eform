/**
 * FTP client wrapper for order import.
 *
 * Responsibilities:
 *   - List *.json order files in the configured remote directory.
 *   - Download a remote file to a local path.
 *   - Move a remote file into a sub-folder (processed/error) on the FTP.
 *
 * Local fallback:
 *   When FTP credentials are missing (typically in dev/test) the same API is
 *   served from a local directory so the rest of the pipeline can still run
 *   end-to-end without a real FTP server.
 *
 * The wrapper opens a fresh FTP connection per `withClient` invocation and
 * always closes it — callers do not need to manage connection lifecycle.
 */

const path = require('path');
const fs = require('fs').promises;
const { Readable } = require('stream');
const { ftpImportPath } = require('../../config');
const { log } = require('../../utils/logging');
const { assertSafeOrderFileName, isSafeOrderFileName } = require('./fileNames');

const IMPORT_STATUS_DIR = '/import-status';

const FTP_ENABLED = Boolean(
  process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASSWORD
);

function isJsonFile(name) {
  return isSafeOrderFileName(name);
}

async function withClient(fn) {
  if (!FTP_ENABLED) {
    throw new Error('FTP not configured (FTP_HOST/FTP_USER/FTP_PASSWORD missing)');
  }
  const ftp = require('basic-ftp');
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      secure: false
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.localFallbackDir]  Used when FTP is disabled.
 * @returns {Promise<string[]>} Array of file names (without path).
 */
async function listOrderFiles({ localFallbackDir } = {}) {
  if (!FTP_ENABLED) {
    if (!localFallbackDir) return [];
    try {
      const entries = await fs.readdir(localFallbackDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && isJsonFile(e.name))
        .map((e) => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  return withClient(async (client) => {
    await client.ensureDir(ftpImportPath);
    const list = await client.list(ftpImportPath);
    return list
      .filter((entry) => entry.type === 1 /* file */ && isJsonFile(entry.name))
      .map((entry) => entry.name);
  });
}

/**
 * Download a remote JSON file to `localPath`. Returns the local path written.
 */
async function downloadOrderFile(fileName, localPath, { localFallbackDir } = {}) {
  assertSafeOrderFileName(fileName);
  await fs.mkdir(path.dirname(localPath), { recursive: true });

  if (!FTP_ENABLED) {
    if (!localFallbackDir) {
      throw new Error('FTP disabled and no localFallbackDir provided');
    }
    const src = path.join(localFallbackDir, fileName);
    if (path.resolve(src) === path.resolve(localPath)) {
      return localPath;
    }
    await fs.copyFile(src, localPath);
    return localPath;
  }

  const remote = path.posix.join(ftpImportPath, fileName);
  await withClient(async (client) => {
    await client.downloadTo(localPath, remote);
  });
  return localPath;
}

/**
 * Move remote file from /<ftpImportPath>/<fileName>
 * to            /<ftpImportPath>/<subdir>/<fileName>.
 */
async function moveRemoteFile(fileName, subdir, { localFallbackDir } = {}) {
  assertSafeOrderFileName(fileName);
  if (!FTP_ENABLED) {
    if (!localFallbackDir) return;
    const src = path.join(localFallbackDir, fileName);
    const destDir = path.join(localFallbackDir, subdir);
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, `${Date.now()}_${fileName}`);
    try {
      await fs.rename(src, dest);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return;
  }

  await withClient(async (client) => {
    const targetDir = path.posix.join(ftpImportPath, subdir);
    await client.ensureDir(targetDir);
    // ensureDir leaves cwd at targetDir — go back to root for the rename below.
    await client.cd('/');
    const from = path.posix.join(ftpImportPath, fileName);
    const to = path.posix.join(targetDir, `${Date.now()}_${fileName}`);
    try {
      await client.rename(from, to);
    } catch (err) {
      log(`FTP rename failed for ${from} -> ${to}: ${err.message}`);
      throw err;
    }
  });
}

/**
 * Upload a text file to /import-status/<name> (root of the FTP, next to /orders-out/).
 */
async function uploadImportStatus(name, content) {
  await withClient(async (client) => {
    await client.ensureDir(IMPORT_STATUS_DIR);
    await client.uploadFrom(Readable.from([Buffer.from(content, 'utf8')]), name);
  });
}

module.exports = {
  FTP_ENABLED,
  listOrderFiles,
  downloadOrderFile,
  moveRemoteFile,
  uploadImportStatus
};
