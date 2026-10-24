'use strict';

/**
 * Filmy do wysłania linkiem (2026-10-23):
 *   GET /film/<nazwa>           — strona z odtwarzaczem (to wysyłamy ludziom),
 *   GET /film/<nazwa>.mp4       — sam plik, z obsługą zapytań Range (przewijanie;
 *                                 Safari bez nich w ogóle nie odtworzy filmu),
 *   GET /film/<nazwa>.<jęz>.vtt — napisy w danym języku (WebVTT).
 *
 * Plik leży w `<moviesDir>/<nazwa>.mp4` (`config.js`). Nowy film = wrzucić plik
 * do katalogu i wysłać link `/film/<nazwa>` — bez zmian w kodzie.
 *
 * Napisy: katalog `<moviesDir>/<nazwa>_sub/`, w nim po jednym pliku `.srt` lub
 * `.vtt` na język, z kodem języka na końcu nazwy: `Eform_napisy_PL.srt`,
 * `de.vtt`, `film-fr.srt`. Nowy język = wrzucić plik, bez restartu. Przeglądarki
 * w `<track>` czytają tylko WebVTT, więc SRT jest przerabiany w locie.
 *
 * Bez logowania: link dostaje ktoś spoza eForm (także w czasie przerwy
 * technicznej — `/film/` jest w `middleware/accessLock.js`). Nazwa wyłącznie
 * z liter, cyfr, `_` i `-`, rozszerzenie wyłącznie `.mp4` albo `.<jęz>.vtt`
 * z językiem z listy znalezionych napisów — żadnych ścieżek.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const NAME_RE = /^([A-Za-z0-9_-]{1,80})(?:(\.mp4)|\.([a-z]{2,3})\.vtt)?$/;
const SUBTITLE_FILE_RE = /(?:^|[_. -])([A-Za-z]{2,3})\.(srt|vtt)$/i;
/** Film nie zmienia się pod tym samym adresem — przeglądarka może go trzymać dobę. */
const FILE_MAX_AGE = '1d';
/** Napisy w języku, którego przeglądarka nie zna, albo bez nagłówka Accept-Language. */
const FALLBACK_LANG = 'en';

/**
 * Napisy filmu: `[{ lang, file }]` posortowane po kodzie języka. Ten sam język
 * w `.srt` i `.vtt` — wygrywa `.vtt` (gotowy, bez przeróbki).
 */
async function findSubtitles(moviesDir, name) {
  const dir = path.join(moviesDir, `${name}_sub`);
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const byLang = new Map();
  for (const file of files.sort()) {
    const match = SUBTITLE_FILE_RE.exec(file);
    if (!match) continue;
    const lang = match[1].toLowerCase();
    if (!byLang.has(lang) || match[2].toLowerCase() === 'vtt') byLang.set(lang, path.join(dir, file));
  }
  return [...byLang].sort(([a], [b]) => a.localeCompare(b)).map(([lang, file]) => ({ lang, file }));
}

/** Nazwa języka w nim samym („Polski”, „Deutsch”) — tak widzi ją widz w menu napisów. */
function languageLabel(lang) {
  try {
    const label = new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
    return label.charAt(0).toLocaleUpperCase(lang) + label.slice(1);
  } catch {
    return lang.toUpperCase();
  }
}

/**
 * SRT → WebVTT: nagłówek `WEBVTT`, przecinek → kropka w znacznikach czasu (tylko
 * w liniach `-->`, „549,46 euro” w treści zostaje), bez BOM i CRLF.
 */
function toWebVtt(text, ext) {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (ext === '.vtt') return body;
  const cues = body.replace(/^.*-->.*$/gm, (line) => line.replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2'));
  return `WEBVTT\n\n${cues.trim()}\n`;
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.moviesDir]      domyślnie `config.moviesDir`
 * @param {string} [opts.publicBaseUrl]  domyślnie `config.publicBaseUrl` (`PUBLIC_BASE_URL`)
 * @returns {import('express').Router}
 */
function createFilmRouter({
  moviesDir = require('../config').moviesDir,
  publicBaseUrl = require('../config').publicBaseUrl
} = {}) {
  const router = express.Router();

  router.get('/:file', (req, res, next) => {
    const match = NAME_RE.exec(req.params.file);
    if (!match) return next();
    const [, name, mp4, subtitleLang] = match;
    const file = path.join(moviesDir, `${name}.mp4`);

    if (mp4) {
      return res.sendFile(file, { maxAge: FILE_MAX_AGE, acceptRanges: true }, (err) => {
        // Przerwane pobieranie (przewinięcie, zamknięta karta) — nagłówki już poszły
        if (!err || res.headersSent) return;
        next(err.status === 404 || err.code === 'ENOENT' ? undefined : err);
      });
    }

    if (subtitleLang) return sendSubtitles(name, subtitleLang, res, next).catch(next);

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return next();
      renderPage(name, req, res).catch(next);
    });
  });

  async function sendSubtitles(name, lang, res, next) {
    const subtitle = (await findSubtitles(moviesDir, name)).find((s) => s.lang === lang);
    if (!subtitle) return next();
    const text = await fs.promises.readFile(subtitle.file, 'utf8');
    // Poprawki literówek idą pod tym samym adresem — zawsze pytać serwer (ETag → 304)
    res.set('Cache-Control', 'no-cache');
    res.type('text/vtt; charset=utf-8').send(toWebVtt(text, path.extname(subtitle.file).toLowerCase()));
  }

  async function renderPage(name, req, res) {
    const langs = (await findSubtitles(moviesDir, name)).map((s) => s.lang);
    // Domyślnie włączone napisy w języku przeglądarki, a gdy go nie ma — angielskie
    // (samo `*` to brak preferencji: negocjacja dałaby pierwszy język alfabetycznie)
    const defaultLang = (/[a-z]/i.test(req.get('accept-language') || '') && req.acceptsLanguages(langs))
      || (langs.includes(FALLBACK_LANG) ? FALLBACK_LANG : langs[0]);
    // Adres bezwzględny do podglądu linku (Teams, WhatsApp, poczta): `PUBLIC_BASE_URL`,
    // a bez niego z żądania (za proxy protokół w `X-Forwarded-Proto`)
    const origin = publicBaseUrl || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
    res.set('Cache-Control', 'no-cache');
    res.render('film.njk', {
      name,
      videoUrl: `/film/${name}.mp4`,
      pageUrl: `${origin}/film/${name}`,
      absoluteVideoUrl: `${origin}/film/${name}.mp4`,
      secure: origin.startsWith('https:'),
      subtitles: langs.map((lang) => ({
        lang,
        label: languageLabel(lang),
        url: `/film/${name}.${lang}.vtt`,
        isDefault: lang === defaultLang
      }))
    });
  }

  return router;
}

module.exports = createFilmRouter();
module.exports.createFilmRouter = createFilmRouter;
