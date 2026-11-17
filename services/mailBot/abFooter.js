const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { log } = require('../../utils/logging');

const CONFIG_PATH = path.join(__dirname, 'abFooter.json');
const IMAGE_CID = 'abfooter_cid';

/**
 * Stopka AB (POP-19) dla `_ab_footer.njk` (mail i PDF/HTML). Zwraca teksty w języku AB
 * + `booth`, `company`, `imagePath` i `img` (src zdjęcia) albo null (wyłączona / brak języka).
 * `imageMode`: 'cid' — mail (zdjęcie jako załącznik inline), 'data' — PDF/HTML (data URI).
 * JSON czytany przy każdym renderze — poprawka treści działa bez restartu.
 */
function abFooter(lang, imageMode = 'data') {
  if (!config.features.abFooter) return null;
  try {
    const { booth = '', company = '', image = '', text = {} } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!text[lang]) return null;
    const imagePath = image && fs.existsSync(path.join(__dirname, image)) ? path.join(__dirname, image) : null;
    let img = null;
    if (imagePath) {
      img = imageMode === 'cid'
        ? `cid:${IMAGE_CID}`
        : `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString('base64')}`;
    }
    return { ...text[lang], booth, company, imagePath, img, compact: imageMode === 'data' };
  } catch (err) {
    // Zepsuty JSON nie może zatrzymać wysyłki AB — idzie bez stopki.
    log('abFooter: błąd odczytu abFooter.json:', err.message);
    return null;
  }
}

module.exports = { abFooter, CONFIG_PATH, IMAGE_CID };
