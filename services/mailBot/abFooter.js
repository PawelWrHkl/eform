const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nunjucks = require('nunjucks');
const config = require('../../config');
const { log } = require('../../utils/logging');

const CONFIG_PATH = path.join(__dirname, 'abFooter.json');
const TEMPLATE_PATH = path.join(__dirname, '_ab_footer.njk');
const IMAGE_CID = 'abfooter_cid';
const BANNER_CID = 'abfooter_banner';
const BANNER_WIDTH = 700;
const BANNER_DIR = path.join(os.tmpdir(), 'eform-abfooter');

/**
 * Stopka AB (POP-19) dla `_ab_footer.njk` (mail i PDF/HTML). Zwraca teksty w języku AB
 * + `fair`, `hall`, `booth`, `company`, `imagePath` i `img` (src logo) albo null (wyłączona / brak języka).
 * `imageMode`: 'cid' — mail, 'data' — PDF/HTML (data URI, niższy baner).
 * `orgIdent` — organizacja zlecenia (`sendData.organizationIdent`); spoza `organizations` z JSON-a = null.
 * W mailu ('cid') dochodzi `bannerPath`, gdy gotowy jest obrazek banera (`ensureAbFooterBanner`):
 * tryb ciemny Outlooka przerabia kolory HTML-a (granat → jasny lawendowy), obrazków nie rusza.
 * JSON czytany przy każdym renderze — poprawka treści działa bez restartu.
 */
function abFooter(lang, imageMode = 'data', orgIdent = null) {
  if (!config.features.abFooter) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const { organizations, fair = '', hall = '', booth = '', company = '', image = '', text = {} } = JSON.parse(raw);
    if (!text[lang]) return null;
    if (Array.isArray(organizations)
      && !organizations.some((o) => String(o).toUpperCase() === String(orgIdent || '').toUpperCase())) return null;
    const imagePath = image && fs.existsSync(path.join(__dirname, image)) ? path.join(__dirname, image) : null;
    let img = null;
    if (imagePath) {
      const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
      img = imageMode === 'cid'
        ? `cid:${IMAGE_CID}`
        : `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
    }
    const footer = { ...text[lang], fair, hall, booth, company, imagePath, img, compact: imageMode === 'data' };
    if (imageMode === 'cid') {
      const banner = bannerFile(lang, raw, imagePath);
      if (fs.existsSync(banner)) Object.assign(footer, { bannerPath: banner, banner: `cid:${BANNER_CID}`, bannerWidth: BANNER_WIDTH });
    }
    return footer;
  } catch (err) {
    // Zepsuty JSON nie może zatrzymać wysyłki AB — idzie bez stopki.
    log('abFooter: błąd odczytu abFooter.json:', err.message);
    return null;
  }
}

/** Plik obrazka banera — nazwa z hasha treści, więc zmiana JSON-a/szablonu/logo = nowy obrazek. */
function bannerFile(lang, rawConfig, imagePath) {
  const hash = crypto.createHash('sha1')
    .update(rawConfig).update(fs.readFileSync(TEMPLATE_PATH))
    .update(imagePath ? fs.readFileSync(imagePath) : '')
    .update(String(BANNER_WIDTH)).update(lang)
    .digest('hex').slice(0, 16);
  return path.join(BANNER_DIR, `${lang}-${hash}.png`);
}

/**
 * Renderuje (raz na treść i język) baner z `_ab_footer.njk` do PNG dla maila. Woła go
 * `sendMailAsync` przed złożeniem maila. Nigdy nie rzuca: przy błędzie mail dostaje baner HTML.
 */
async function ensureAbFooterBanner(lang, orgIdent = null) {
  const footer = abFooter(lang, 'data', orgIdent);
  if (!footer) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const file = bannerFile(lang, raw, footer.imagePath);
    if (fs.existsSync(file)) return file;

    const html = new nunjucks.Environment(new nunjucks.FileSystemLoader(__dirname), { autoescape: true })
      .render('_ab_footer.njk', { abFooter: { ...footer, compact: false } });
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: BANNER_WIDTH, height: 400 } });
      await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"><div id="b" style="width:${BANNER_WIDTH}px">${html}</div></body></html>`);
      fs.mkdirSync(BANNER_DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await page.locator('#b').screenshot({ path: tmp, type: 'png' });
      fs.renameSync(tmp, file); // atomowo — równoległa wysyłka nie weźmie połowy pliku
    } finally {
      await browser.close();
    }
    return file;
  } catch (err) {
    log('abFooter: nie udało się wyrenderować banera, mail dostanie baner HTML:', err.message);
    return null;
  }
}

module.exports = { abFooter, ensureAbFooterBanner, CONFIG_PATH, IMAGE_CID, BANNER_CID, BANNER_WIDTH };
