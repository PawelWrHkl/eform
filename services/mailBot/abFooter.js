const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { log } = require('../../utils/logging');

const CONFIG_PATH = path.join(__dirname, 'abFooter.json');

/**
 * Stopka AB (POP-19) dla mailTemplate.njk i order-pdf.njk (PDF + załącznik HTML).
 * Zwraca tekst w języku AB z podstawionym `{booth}` albo null (wyłączona / brak języka).
 * JSON czytany przy każdym renderze — poprawka treści działa bez restartu.
 */
function abFooter(lang) {
  if (!config.features.abFooter) return null;
  try {
    const { booth = '', text = {} } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return text[lang] ? text[lang].replaceAll('{booth}', booth) : null;
  } catch (err) {
    // Zepsuty JSON nie może zatrzymać wysyłki AB — idzie bez stopki.
    log('abFooter: błąd odczytu abFooter.json:', err.message);
    return null;
  }
}

module.exports = { abFooter, CONFIG_PATH };
