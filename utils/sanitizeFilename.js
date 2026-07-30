/**
 * Strips diacritics/spaces from a filename, keeping only the extension's dot.
 * Some mail clients (notably iOS Mail) fail to open/save attachments whose
 * Content-Disposition filename contains non-ASCII characters or spaces, even
 * though the RFC 2231 encoding nodemailer generates is technically valid.
 */
function sanitizeFilename(name) {
    const dotIndex = name.lastIndexOf('.');
    const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
    const ext = dotIndex > 0 ? name.slice(dotIndex) : '';

    const cleanBase = base
        .replace(/ł/g, 'l').replace(/Ł/g, 'L') // ł/Ł don't decompose via NFD
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip combining diacritics (ą,ć,ę,ń,ó,ś,ź, ...)
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return `${cleanBase}${ext}`;
}

module.exports = { sanitizeFilename };
