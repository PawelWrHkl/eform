/**
 * Pasek "dane z pamięci lokalnej" — pokazywany, gdy `DataLoader.loadData()`
 * (formTools/dataLoader.js) nie mógł pobrać pliku z sieci i zastąpił go
 * kopią zapisaną wcześniej w localStorage (patrz komentarz przy
 * `cacheRawText`/`readCachedRawText` w tym samym pliku).
 *
 * Konfigurator liczy realne ceny do zamówień — dane z cache mogą być
 * nieaktualne (inny cennik, inne reguły), więc to NIE ma być ciche: widoczny
 * pasek zostaje, dopóki kolejny fetch się nie powiedzie (`hideOfflineBanner`
 * wołane z `loadData()` po pierwszym udanym pobraniu po awarii).
 */

const BANNER_ID = 'eform-offline-banner';
let cachedAt = null;

function formatCachedAt(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString(document.documentElement.lang || 'pl');
    } catch (_err) {
        return '';
    }
}

export function showOfflineBanner(timestamp) {
    if (timestamp && (!cachedAt || timestamp > cachedAt)) cachedAt = timestamp;

    let banner = document.getElementById(BANNER_ID);
    if (banner) {
        const timeEl = banner.querySelector('.eform-offline-banner-time');
        if (timeEl) timeEl.textContent = formatCachedAt(cachedAt);
        return;
    }

    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
        <span class="eform-offline-banner-text">
            ${t('form.offline_banner_text')}
            <span class="eform-offline-banner-time">${formatCachedAt(cachedAt)}</span>
        </span>
    `;
    document.body.prepend(banner);
}

export function hideOfflineBanner() {
    cachedAt = null;
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove();
}
