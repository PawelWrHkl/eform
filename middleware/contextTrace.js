// TYMCZASOWE (diagnoza „admin traci kontekst klienta na /orders/add-order"):
// loguje każdą zmianę `session.context_user` z adresem żądania, które ją
// zrobiło — także nadpisanie sesji starą kopią przez równoległe żądanie
// (zapis do store'u, którego kontekst różni się od tego, co w nim było).
const { AsyncLocalStorage } = require('async_hooks');
const { log } = require('../utils/logging');

const als = new AsyncLocalStorage();
const identOf = (s) => (s && s.context_user && s.context_user.ident) || null;

function installStoreTrace(store) {
    const origSet = store.set.bind(store);
    store.set = (sid, sess, cb) => {
        let prev = null;
        try { prev = identOf(JSON.parse(store.sessions[sid] || 'null')); } catch (_) { /* brak */ }
        const next = identOf(sess);
        if (prev !== next) {
            const req = als.getStore();
            const loaded = req ? req._ctxTraceLoaded : '?';
            log(`[ctxTrace] SAVE ${sid.slice(0, 6)} ${prev} -> ${next} | ${req ? req.method + ' ' + req.originalUrl : '?'} | wczytane: ${loaded}${loaded !== prev ? ' ⚠️ NADPISANIE STARĄ KOPIĄ' : ''}`);
        }
        return origSet(sid, sess, cb);
    };
}

function contextTrace(req, res, next) {
    req._ctxTraceLoaded = identOf(req.session);
    if (!req.session?.user && req.cookies?.['connect.sid']) {
        log(`[ctxTrace] nieznana sesja (ciasteczko nie pasuje do store'u) | ${req.method} ${req.originalUrl}`);
    }
    als.run(req, next);
}

module.exports = { installStoreTrace, contextTrace };
