import { createElement } from "./components/htmlManipulator.js";
import { getEnvVersion } from "./getEnv.js";
import { get } from "./components/api_connector.js";

async function getLogo() {
    try {
        const response = await fetch('/user/logo', {
            method: 'GET',
            credentials: 'include'
        });
        if (!response.ok) throw new Error('Status nieok: ' + response.status);

        const blob = await response.blob();
        const images = document.querySelectorAll('.logo');
        if (images.length === 0) throw new Error('Brak .logo w DOM');

        const base64data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        await Promise.all(Array.from(images).map(img => {
            return new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('Błąd ładowania obrazu'));
                img.src = base64data;
            });
        }));

    } catch (err) {
        console.error('getLogo Error:', err);
        throw err;
    }
}


getLogo()
    .catch(err => console.error('Final error:', err));

async function getEmployyeInfo() {
    try {
        await fetch('/user/employee-info', {
            method: 'GET',
            credentials: 'include'
        });
    } catch (err) {
        console.error('getEmployyeInfo Error:', err);
    }
}

export function validate(validateClass) {
    let inputs = document.querySelectorAll(validateClass);
    let allValid = true;

    inputs.forEach(field => {
        const value = typeof field.value === 'string' ? field.value.trim() : '';


        let errorMsg = field.nextElementSibling;
        if (!errorMsg || !errorMsg.classList.contains('input-error-msg')) {
            errorMsg = null;
        }

        if (value.length < 1) {
            field.classList.add('input-error');
            allValid = false;

            if (!errorMsg) {

                errorMsg = document.createElement('div');
                errorMsg.className = 'input-error-msg';
                errorMsg.textContent = t('form.field_cant_be_empty');
                field.parentNode.insertBefore(errorMsg, field.nextSibling);
            }
        } else {
            field.classList.remove('input-error');
            if (errorMsg) {
                errorMsg.remove();
            }
        }
    });

    return allValid;
}

export async function getUserName() {
    const user = await fetch('/user/name', {
        method: 'GET',
        credentials: 'include'
    });
    if (!user.ok) {
        throw new Error('Nie udało się pobrać nazwy użytkownika: ' + user.status);
    }
    const data = await user.json();
    if (!data.success) {
        throw new Error('Błąd pobierania nazwy użytkownika: ' + data.message);
    }

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');


    let contextInfo = '';
    try {
        const contextBtns = document.querySelectorAll('.context-button');
        const contextResponse = await fetch('/context-user', {
            method: 'GET',
            credentials: 'include'
        });
        if (contextResponse.ok) {

            const contextData = await contextResponse.json();
            setContextUserSelected(contextData.ident);
            if (contextData.success && contextData.contextUser) {
                window.context = true
                contextBtns.forEach(contextBtn => {
                    contextBtn.classList.remove('d-none');
                });
                contextInfo = `<br><p id='ident'>ID: ${contextData.ident}</p>(${contextData.userName}) `;
            }
            else {
                window.context = false
                contextBtns.forEach(contextBtn => {
                    contextBtn.classList.add('d-none');
                });
            }
        }
    } catch (err) {
        console.error('Błąd pobierania context user:', err);
    }

    setTimeout(() => {

        const shopInfo = data.shopName
            ? `</br><p class='pt-2'>Filia: </br> ${escapeHtml(data.shopName)}</p>`
            : '';

        // Konto podrzędne grupy typu `client` (`window.hideParentUserInfo`,
        // patrz services/groupType.js) widzi tu WYŁĄCZNIE swoją filię — nazwa
        // i mail należą do grupy-matki, więc dla klienta grupy są mylące.
        // ⚠️ Warunek na istnienie elementu zostaje: bez niego TypeError
        // zabijał całą resztę callbacku, w tym `getEmp()`.
        const userInfoEl = document.getElementById('user-info');
        if (userInfoEl) {
            userInfoEl.innerHTML = window.hideParentUserInfo
                ? shopInfo.replace(/^<\/br>/, '')
                : `${t('base.user')}: </br> ${escapeHtml(data.name)}
        ${shopInfo}
        </br> <p class='pt-2'>Mail: </br> ${escapeHtml(data.email)}</p>  ${contextInfo}`;
        }
        getEmp();
    }, 100);
    return data;
}

// ─── Recent users helpers (fetched from DB via API) ─────────────────────────

const RECENT_USERS_MAX = 10;
let _recentClientsCache = null;

async function fetchRecentClients() {
    if (_recentClientsCache !== null) return _recentClientsCache;
    try {
        const res = await fetch('/recent-clients', { method: 'GET', credentials: 'include' });
        if (!res.ok) return [];
        _recentClientsCache = await res.json();
        return _recentClientsCache;
    } catch { return []; }
}

function invalidateRecentClientsCache() {
    _recentClientsCache = null;
}

// ─── Dropdown factory ───────────────────────────────────────────────────────

function initUserDropdown(inputId, dropdownId, onSelect) {
    const userInput = document.getElementById(inputId);
    const userDropdown = document.getElementById(dropdownId);
    let allUsers = [];

    if (!userInput || !userDropdown) return { input: null, allUsers };

    const dropdownItems = userDropdown.querySelectorAll('.dropdown-item');
    dropdownItems.forEach(item => {
        const name = item.textContent.trim();
        const ident = item.getAttribute('data-value');
        if (name && name !== '' && name !== '-' && name.trim() !== '') {
            allUsers.push({ ident, name });
        }
    });

    allUsers.sort((a, b) => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' }));

    function renderDropdown(recent) {
        userDropdown.innerHTML = '';

        const recentIdents = new Set((recent || []).map(u => u.ident));

        // Recent users on top (only those still in allUsers)
        const validRecent = (recent || []).filter(r => allUsers.some(u => u.ident === r.ident));
        if (validRecent.length > 0) {
            validRecent.forEach(user => {
                const item = document.createElement('div');
                item.className = 'dropdown-item dropdown-item-recent';
                item.setAttribute('data-value', user.ident);
                item.textContent = user.ident;
                userDropdown.appendChild(item);
            });
            const sep = document.createElement('div');
            sep.className = 'dropdown-separator';
            userDropdown.appendChild(sep);
        }

        // Remaining users (alphabetical, skip those already shown as recent)
        allUsers.forEach(user => {
            if (recentIdents.has(user.ident)) return;
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.setAttribute('data-value', user.ident);
            item.textContent = user.name;
            userDropdown.appendChild(item);
        });
    }

    // Initial render without recent (will be updated on focus)
    renderDropdown([]);

    function getAllDropdownItems() {
        return userDropdown.querySelectorAll('.dropdown-item');
    }

    async function openDropdown() {
        const recent = await fetchRecentClients();
        renderDropdown(recent);
        showAllItems();
        userDropdown.classList.add('show');
    }

    userInput.addEventListener('focus', function () {
        openDropdown();
    });

    userInput.addEventListener('click', function () {
        openDropdown();
    });

    userInput.addEventListener('input', function () {
        filterItems(this.value.toLowerCase());
    });

    userDropdown.addEventListener('click', function (e) {
        if (e.target.classList.contains('dropdown-item')) {
            const selectedName = e.target.textContent.trim();
            const selectedIdent = e.target.getAttribute('data-value');
            userInput.value = selectedName;
            userDropdown.classList.remove('show');
            invalidateRecentClientsCache();
            if (selectedIdent) {
                fetch('/recent-clients', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ident: selectedIdent, name: selectedName })
                }).catch(() => {});
            }
            if (onSelect) onSelect(selectedIdent, selectedName);
        }
    });

    document.addEventListener('click', function (e) {
        if (!userInput.contains(e.target) && !userDropdown.contains(e.target)) {
            userDropdown.classList.remove('show');
        }
    });

    userInput.addEventListener('keydown', function (e) {
        const visibleItems = userDropdown.querySelectorAll('.dropdown-item:not(.hidden)');
        let currentIndex = -1;
        visibleItems.forEach((item, index) => {
            if (item.classList.contains('highlighted')) currentIndex = index;
        });

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            currentIndex = currentIndex < visibleItems.length - 1 ? currentIndex + 1 : 0;
            highlightItem(visibleItems, currentIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            currentIndex = currentIndex > 0 ? currentIndex - 1 : visibleItems.length - 1;
            highlightItem(visibleItems, currentIndex);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (currentIndex >= 0 && visibleItems[currentIndex]) visibleItems[currentIndex].click();
        } else if (e.key === 'Escape') {
            userDropdown.classList.remove('show');
        }
    });

    function showAllItems() {
        getAllDropdownItems().forEach(item => item.classList.remove('hidden', 'highlighted'));
        userDropdown.querySelectorAll('.dropdown-separator').forEach(s => s.classList.remove('hidden'));
    }

    function filterItems(searchTerm) {
        let anyRecentVisible = false;
        getAllDropdownItems().forEach(item => {
            const text = item.textContent.toLowerCase();
            const match = text.includes(searchTerm);
            item.classList.toggle('hidden', !match);
            item.classList.remove('highlighted');
            if (match && item.classList.contains('dropdown-item-recent')) anyRecentVisible = true;
        });
        userDropdown.querySelectorAll('.dropdown-separator').forEach(s => {
            s.classList.toggle('hidden', !anyRecentVisible);
        });
        userDropdown.classList.add('show');
    }

    function highlightItem(visibleItems, index) {
        visibleItems.forEach(item => item.classList.remove('highlighted'));
        if (visibleItems[index]) {
            visibleItems[index].classList.add('highlighted');
            visibleItems[index].scrollIntoView({ block: 'nearest' });
        }
    }

    return { input: userInput, allUsers };
}

// Make initUserDropdown available globally for owner.js
window.initUserDropdown = initUserDropdown;

function setContextUserSelected(ident) {
    const dropdownInput = document.getElementById('userSelect')
    if (dropdownInput && ident) {
        dropdownInput.value = ident;
    }
    else if (dropdownInput) {
        dropdownInput.value = '';
    }
}

async function getConfigNum() {
    const version = await getEnvVersion();
    const user = await fetch('/config-num', {
        method: 'GET',
    });
    const data = await user.json();
    if (!data.success) {
        throw new Error('Błąd pobierania nazwy użytkownika: ' + data.message);
    }





    document.getElementById('config-number-info').innerHTML =

        `Numer konfiguracji <br> ${data.name}`;


}

function getEmp() {
    let empBtn = document.getElementById('employee-panel-nav-btn');
    let mobileEmpItem = document.getElementById('mobile-employee-panel-item');
    let mobileEmpLink = document.getElementById('mobile-employee-panel-link');
    let UserNameDiv = document.getElementById('user-info');

    if (empBtn) {
        fetch('/employee-status', {
            method: 'GET',
            credentials: 'include'
        })
            .then(response => response.json())

            .then(data => {

                if (data.success && !data.isEmployee) {
                    empBtn.classList.remove('d-none');
                    empBtn.href = data?.path ?? '/';
                    if (mobileEmpItem) mobileEmpItem.classList.remove('d-none');
                    if (mobileEmpLink) mobileEmpLink.href = data?.path ?? '/';
                    window.isEmployee = data.isEmployee

                } else {
                    empBtn.classList.add('d-none');
                    if (mobileEmpItem) mobileEmpItem.classList.add('d-none');
                    createElement(
                        'div',
                        {
                            id: 'employee-info',
                            class: ['employee-info', 'mt-2'],
                            text: (`${t('base.employee_panel_active')}:`)
                        },
                        UserNameDiv
                    );
                    createElement('span', { text: data.name }, UserNameDiv);
                }
            })
            .catch(err => {
                console.error('Błąd pobierania statusu pracownika:', err);
                empBtn.classList.add('d-none');
                if (mobileEmpItem) mobileEmpItem.classList.add('d-none');
            });
    }
}

getConfigNum()

getUserName()
    .catch(err => console.error('getUserName Error:', err));


document.addEventListener('DOMContentLoaded', function () {
    // ── Mobile back button ──────────────────────────────────────
    const mobileBackBtn = document.getElementById('mobile-back-btn');
    if (mobileBackBtn && window.location.pathname !== '/') {
        mobileBackBtn.classList.remove('d-none');
    }

    const lastUserBtn = document.getElementById('last-user-btn')
    const navToggleBtn = document.getElementById('navToggleBtn');
    const desktopNav = document.querySelector('.desktop-nav');

    if (navToggleBtn && desktopNav) {

        const isCollapsed = localStorage.getItem('nav-collapsed') === 'true';
        if (isCollapsed) {
            document.documentElement.classList.add('nav-collapsed');
            desktopNav.classList.add('collapsed');
        }

        navToggleBtn.addEventListener('click', function () {
            const isCurrentlyCollapsed = document.documentElement.classList.contains('nav-collapsed');

            if (isCurrentlyCollapsed) {
                document.documentElement.classList.remove('nav-collapsed');
                desktopNav.classList.remove('collapsed');
                localStorage.setItem('nav-collapsed', 'false');
            } else {
                document.documentElement.classList.add('nav-collapsed');
                desktopNav.classList.add('collapsed');
                localStorage.setItem('nav-collapsed', 'true');
            }
        });
    }
    if (lastUserBtn) {
        lastUserBtn.addEventListener('click', function () {
            getLocalStorageUsers();
        });
    }
});


document.addEventListener('DOMContentLoaded', function () {

    // ⚠️ Nawigacja NIE polega już na tym handlerze — przyciski wylogowania
    // w `base.njk` są zwykłymi formularzami POST i działają bez JS-u.
    // Handler zostaje dla ewentualnych innych elementów z `data-action="logout"`.
    const logoutLinks = document.querySelectorAll('[data-action="logout"]');

    function handleLogout(event) {
        event.preventDefault();


        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/user/logout';
        document.body.appendChild(form);
        form.submit();
    }

    logoutLinks.forEach((link) => {
        link.addEventListener('click', handleLogout);
    });
});

function getLocalStorageUsers() {
    let orgIdent = localStorage.getItem('orgIdent');
    console.log('orgIdent:', orgIdent);
    let userPath = localStorage.getItem('lastUserPath');

    if (!orgIdent || !userPath) {
        console.error('Missing orgIdent or userPath in localStorage');
        return;
    }

    console.log('Organization Ident:', orgIdent);
    console.log('Last User Path:', userPath);

    fetch('/set-last-user', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            orgIdent: orgIdent,
            userPath: userPath
        })
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Pomyślnie ustawiono organizację i kontekst użytkownika');

                if (data.redirectUrl) {
                    window.location.href = data.redirectUrl;
                }
            } else {
                console.error('Błąd:', data.message);
            }
        })
        .catch(err => {
            console.error('Błąd podczas ustawiania użytkownika:', err);
        });
}

// Init sidebar user dropdown (works on all pages)
document.addEventListener('DOMContentLoaded', function () {
    function getOrgIdent() {
        return fetch('/get-org-ident', { method: 'GET', credentials: 'include' })
            .then(response => response.json())
            .then(data => {
                if (data.organization) {
                    localStorage.setItem('orgIdent', `${data.organization}`);
                    return data.organization;
                }
            })
            .catch(err => console.error('Błąd pobierania orgIdent:', err));
    }

    function handleSidebarUserSelect(selectedIdent) {
        const targetPath = `/orders/userOrders?userIdent=${encodeURIComponent(selectedIdent)}`;
        localStorage.setItem('lastUserPath', targetPath);
        getOrgIdent().then(() => { window.location.href = targetPath; });
    }

    initUserDropdown('userSelect', 'userDropdown', handleSidebarUserSelect);

    // ── Kontekst konta podrzędnego grupy (sklep/klient) ──────────────────────
    // Wybór z listy = wejście w kontekst, puste = wyjście. Zwykłe przejście
    // adresem, bez fetcha: kontekst siedzi w sesji, więc po przekierowaniu cała
    // strona (nawigacja, lista zamówień) ma już właściwy zakres.
    ['groupShopSelect', 'mobileGroupShopSelect'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        select.addEventListener('change', () => {
            const shopId = select.value;
            window.location.href = shopId
                ? `/group/context/${encodeURIComponent(shopId)}`
                : '/group/context/clear';
        });
    });
});

// Session heartbeat
(function () {
    if (window.location.pathname === '/user/login') return;

    var overlay = document.getElementById('connection-lost-overlay');
    var refreshBtn = document.getElementById('connection-lost-refresh');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', function () {
            window.location.reload();
        });
    }

    function showOverlay() {
        if (overlay) overlay.classList.remove('d-none');
    }

    function hideOverlay() {
        if (overlay) overlay.classList.add('d-none');
    }

    setInterval(function () {
        fetch('/user/session-check', { credentials: 'include' })
            .then(function (r) {
                if (r.status === 401) { window.location.href = '/user/login'; }
                else { hideOverlay(); }
            })
            .catch(function () { showOverlay(); });
    }, 15000);
})();


