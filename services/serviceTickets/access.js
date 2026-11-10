'use strict';

/**
 * Kto widzi moduł „Serwis” — JEDNA reguła dla menu (`res.locals.serviceEnabled`),
 * routera `/service`, przycisków „Zgłoś problem” i asystenta (orderScope → pages.js).
 *
 * `SERVICE_ENABLED=true`   — każdy zalogowany (klient, pracownik, grupa, sklep grupy,
 *                            biuro i admin w kontekście klienta, konto demo),
 * `SERVICE_ENABLED=admins` — pilotaż: wyłącznie administrator (wzorzec ASSISTANT_ENABLED),
 * cokolwiek innego / brak  — moduł wyłączony, router nie jest montowany.
 *
 * @param {{ isAdmin?: boolean }|null|undefined} sessionUser  `req.session.user`
 * @param {{ mode: 'true'|'admins'|'off' }} [cfg]  domyślnie `config.service`
 */
function canAccessService(sessionUser, cfg = require('../../config').service) {
  if (!sessionUser || !cfg) return false;
  if (cfg.mode === 'true') return true;
  if (cfg.mode === 'admins') return !!sessionUser.isAdmin;
  return false;
}

module.exports = { canAccessService };
