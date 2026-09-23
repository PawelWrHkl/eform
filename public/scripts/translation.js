window.translations = {};
window.language = 'pl'
/**
 * Tłumaczenie klucza, opcjonalnie z podstawieniem zmiennych `{nazwa}`.
 *
 * ⚠️ `vars` jest opcjonalne i wywołania bez niego działają dokładnie jak dotąd —
 * podstawianie rusza tylko wtedy, gdy ktoś je poda.
 *
 * ⚠️ Nieznany placeholder ZOSTAJE w tekście (`{percent}`), a nie zamienia się
 * w „undefined": brakującą zmienną widać wtedy od razu, zamiast pokazywać
 * klientowi śmieć w opisie ceny.
 */
window.t = function (key, vars) {
  const value = key.split('.').reduce((o, k) => (o || {})[k], window.translations) || key;
  if (!vars || typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (placeholder, nazwa) =>
    Object.prototype.hasOwnProperty.call(vars, nazwa) ? String(vars[nazwa]) : placeholder);
};

// Odpowiednik serwerowego `gk()` (services/groupType.js) dla skryptów: etykiety
// modułu grupowego w odmianie `client` mają własne brzmienie w `group.client.*`.
// Gdy tłumaczenia nie ma, wracamy do `group.*` — inaczej `t()` pokazałby surowy
// klucz.
window.gk = function (key) {
  const short = String(key || '').replace(/^group\./, '');
  if (window.groupType === 'client' && window.translations?.group?.client?.[short]) {
    return `group.client.${short}`;
  }
  return `group.${short}`;
};

window.loadTranslations = async function (lang) {
  try {
    const res = await fetch(`/translations?lang=${lang}`);
    window.translations = await res.json();
  } catch (error) {
    if (
      error instanceof SyntaxError &&
      error.message.includes('Unexpected token <')
    ) {
      if (!window.location.pathname.includes('/user/login')) {
        window.location.href = '/user/login';
      }
    } else {
      console.error(error);
    }
  }
};

window.loadLangs = async function getLanguages() {
  try {
    const response = await fetch('/languages');
    if (!response.ok) {
      throw new Error('Błąd podczas pobierania języka');
    }
    const data = await response.json();
    window.langs = data.body.availableLanguages;

    return data.body.lang;
  } catch (error) {
    if (!window.location.pathname.includes('/user/login')) {
      window.location.href = '/user/login';
    }
    console.error('Wystąpił błąd:', error);
    return null;
  }
}

window.translationsReady = window.loadTranslations(document.documentElement.lang || 'en');
window.loadLangs()
