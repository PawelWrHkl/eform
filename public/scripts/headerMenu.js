/* =============================================================================
   MENU KONTA W NAGŁÓWKU (`[data-header-menu]` w base.njk) — oba warianty
   =============================================================================
   Rozwijanie i klawiaturę obsługuje dropdown Bootstrapa, pozycje mają własne
   skrypty (themeToggle.js, uiVariant.js, intro/main.js). Tu tylko dane konta:
   inicjały na awatarze, nazwa i mail w nagłówku listy — z tego samego
   `/user/name`, które pobiera base.js (`window.eformUser` + `eform:user-loaded`).
   ============================================================================= */

const LEGAL_FORMS = new Set(['sp', 'z', 'o', 'oo', 'sa', 'sk', 'spk', 'gmbh', 'ag', 'kg', 'ug', 'ohg', 'bv', 'nv', 'vof', 'sarl', 'sas', 'eurl', 'ltd', 'llc', 'inc', 'co', 'srl', 'spa', 'e', 'k']);

/** Inicjały do awatara: „Paweł Woroniecki” → PW, „Testowy sp. z o.o.” → TE. */
export function initialsOf(name) {
    const words = String(name || '')
        .split(/[\s.,&/()+-]+/)
        .map((w) => w.trim())
        .filter((w) => /\p{L}/u.test(w) && !LEGAL_FORMS.has(w.toLowerCase()));
    if (!words.length) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

function fillMenu(data) {
    if (!data) return;
    // Konto podrzędne grupy typu `client` widzi WYŁĄCZNIE swoją filię — nazwa
    // i mail grupy-matki są dla niego mylące (ta sama reguła co base.js).
    const name = squash(window.hideParentUserInfo ? (data.shopName || data.name) : data.name);
    const mail = window.hideParentUserInfo ? '' : squash(data.email);
    const initials = initialsOf(name);

    if (initials) {
        document.querySelectorAll('[data-header-menu-initials]').forEach((node) => {
            node.textContent = initials;
            node.classList.add('has-initials');
        });
    }
    document.querySelectorAll('[data-header-menu-name]').forEach((node) => {
        if (name) node.textContent = name;
    });
    document.querySelectorAll('[data-header-menu-mail]').forEach((node) => {
        node.textContent = mail;
    });
}

fillMenu(window.eformUser);
window.addEventListener('eform:user-loaded', (event) => fillMenu(event.detail));
