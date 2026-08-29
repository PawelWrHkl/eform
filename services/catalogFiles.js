const fs = require('fs');
const path = require('path');

/**
 * Katalogi/cenniki PDF do panelu użytkownika (`routes/userPanel.js`).
 *
 * Udział sieciowy zamontowany przez fstab (SMB, `//192.168.0.2/inne/...`,
 * ten sam serwer co `/mnt/Sendungstermine`) — w środku jeden podfolder na
 * organizację, nazwany dokładnie jak `organization.ident` z bazy. Admin
 * zarządza plikami ręcznie na serwerze plików — brak (na razie) UI do
 * uploadu z poziomu eForm.
 */
const CATALOGS_ROOT = '/mnt/eform_catalogs';

/**
 * @param {string} orgIdent `organization.ident` właściciela zamówienia.
 * @returns {string|null} bezpieczna, absolutna ścieżka do folderu organizacji,
 *   albo `null` gdy folder nie istnieje — wtedy zakładka katalogów ma być pusta,
 *   NIE pokazywać plików innej organizacji ani całego udziału.
 *
 * ⚠️ Dopasowanie BEZ rozróżniania wielkości liter: mount jest case-sensitive
 * (`unix,posixpaths`), a `organization.ident` i nazwa folderu na dysku bywają
 * zapisane różną wielkością liter (np. ident `Cozy` w bazie, folder `COZY` na
 * udziale) — dokładne porównanie zostawiałoby tę organizację bez katalogów.
 */
function resolveOrgCatalogDir(orgIdent) {
    if (!orgIdent || typeof orgIdent !== 'string') return null;
    const safeIdent = path.basename(orgIdent);
    if (safeIdent !== orgIdent) return null;
    if (!fs.existsSync(CATALOGS_ROOT)) return null;
    const match = fs.readdirSync(CATALOGS_ROOT)
        .find((entry) => entry.toLowerCase() === safeIdent.toLowerCase());
    if (!match) return null;
    const dir = path.join(CATALOGS_ROOT, match);
    if (!dir.startsWith(CATALOGS_ROOT + path.sep)) return null;
    if (!fs.statSync(dir).isDirectory()) return null;
    return dir;
}

function listCatalogFiles(orgIdent) {
    const dir = resolveOrgCatalogDir(orgIdent);
    if (!dir) return [];
    return fs.readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.pdf'))
        .map((name) => {
            const stat = fs.statSync(path.join(dir, name));
            return { name, size: stat.size, mtime: stat.mtime };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
}

/**
 * Waliduje nazwę pliku z żądania i zwraca bezpieczną, absolutną ścieżkę
 * wewnątrz folderu danej organizacji, albo `null` — chroni przed path
 * traversal (`../../etc/passwd` itp.), bo nazwa idzie wprost z URL-a, oraz
 * przed pobraniem pliku innej organizacji przez zgadywanie nazwy.
 */
function resolveCatalogFile(orgIdent, name) {
    const dir = resolveOrgCatalogDir(orgIdent);
    if (!dir || !name || typeof name !== 'string') return null;
    const safeName = path.basename(name);
    if (safeName !== name) return null;
    const full = path.join(dir, safeName);
    if (!full.startsWith(dir + path.sep)) return null;
    if (!fs.existsSync(full)) return null;
    return full;
}

module.exports = { CATALOGS_ROOT, listCatalogFiles, resolveCatalogFile };
