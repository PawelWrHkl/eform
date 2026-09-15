document.addEventListener('DOMContentLoaded', function () {
    // Add home-page class to body (used by CSS for page-specific layout)
    document.body.classList.add('home-page');

    // Access lock toggle
    const accessLockBtn = document.getElementById('btn-access-lock');
    const accessLockStatus = document.getElementById('access-lock-status');
    if (accessLockBtn) {
        accessLockBtn.addEventListener('click', async function () {
            const btn = this;
            const currentlyBlocked = btn.classList.contains('btn-success');
            const nextBlocked = !currentlyBlocked;

            btn.disabled = true;
            try {
                const resp = await fetch('/admin/access-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ blocked: nextBlocked })
                });
                const data = await resp.json();
                if (data.success) {
                    if (data.blocked) {
                        btn.className = 'btn btn-success text-white';
                        btn.innerHTML = '<i class="bi bi-unlock me-1"></i> Odblokuj dostęp';
                        accessLockStatus.className = 'badge bg-danger fs-6';
                        accessLockStatus.textContent = 'Dostęp zablokowany';
                        const logoutInfo = data.loggedOut ? ` Wylogowano ${data.loggedOut} sesji.` : '';
                        toastr.warning('Dostęp zablokowany — tylko admin może się zalogować.' + logoutInfo);
                    } else {
                        btn.className = 'btn btn-danger text-white';
                        btn.innerHTML = '<i class="bi bi-lock me-1"></i> Zablokuj dostęp';
                        accessLockStatus.className = 'badge bg-secondary fs-6';
                        accessLockStatus.textContent = 'Dostęp otwarty';
                        toastr.success('Dostęp odblokowany');
                    }
                } else {
                    toastr.error('Nie udało się zmienić blokady dostępu');
                }
            } catch (e) {
                toastr.error('Błąd połączenia z serwerem');
            }
            btn.disabled = false;
        });
    }

    // Rabat 1% za korzystanie z serwisu
    const portalDiscountBtn = document.getElementById('btn-portal-discount');
    const portalDiscountStatus = document.getElementById('portal-discount-status');
    if (portalDiscountBtn) {
        portalDiscountBtn.addEventListener('click', async function () {
            const btn = this;
            // Stan czytany z klasy przycisku, tak samo jak przy blokadzie dostępu:
            // btn-warning = rabat obecnie włączony (przycisk go wyłącza).
            const currentlyEnabled = btn.classList.contains('btn-warning');
            const nextEnabled = !currentlyEnabled;

            if (currentlyEnabled && !confirm('Wyłączyć rabat 1% za korzystanie z serwisu? Nowe wyceny przestaną go naliczać.')) {
                return;
            }

            btn.disabled = true;
            try {
                const resp = await fetch('/admin/portal-discount', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: nextEnabled })
                });
                const data = await resp.json();
                if (data.success) {
                    if (data.enabled) {
                        btn.className = 'btn btn-warning text-white';
                        btn.innerHTML = '<i class="bi bi-toggle-off me-1"></i> Wyłącz rabat';
                        portalDiscountStatus.className = 'badge bg-success fs-6';
                        portalDiscountStatus.textContent = 'Rabat włączony';
                        toastr.success('Rabat 1% włączony — nowe wyceny znów go naliczą.');
                    } else {
                        btn.className = 'btn btn-success text-white';
                        btn.innerHTML = '<i class="bi bi-toggle-on me-1"></i> Włącz rabat';
                        portalDiscountStatus.className = 'badge bg-danger fs-6';
                        portalDiscountStatus.textContent = 'Rabat wyłączony';
                        toastr.warning('Rabat 1% wyłączony. Zamówienia już wysłane zachowują swój rabat.');
                    }
                } else {
                    toastr.error('Nie udało się przełączyć rabatu');
                }
            } catch (e) {
                toastr.error('Błąd połączenia z serwerem');
            }
            btn.disabled = false;
        });
    }

    // Active sessions panel
    const sessionsBtn = document.getElementById('btn-active-sessions');
    if (sessionsBtn) {
        sessionsBtn.addEventListener('click', async function () {
            const btn = this;
            const resultDiv = document.getElementById('sessions-result');
            const countBadge = document.getElementById('sessions-count');
            const list = document.getElementById('sessions-list');

            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-hourglass-split me-1"></i> Ładowanie...';

            try {
                const resp = await fetch('/admin/active-sessions');
                const data = await resp.json();

                if (data.success) {
                    countBadge.textContent = 'Aktywne sesje: ' + data.count;
                    list.innerHTML = '';

                    if (data.users.length === 0) {
                        list.innerHTML = '<li class="list-group-item text-muted">Brak aktywnych sesji</li>';
                    } else {
                        data.users.forEach(function (u) {
                            const li = document.createElement('li');
                            li.className = 'list-group-item d-flex justify-content-between align-items-center';

                            let identText = (u.ident || 'Nieznany') + ' (' + u.role;
                            if (u.contextUser) identText += ' → klient: ' + u.contextUser;
                            identText += ')';
                            li.appendChild(document.createTextNode(identText));

                            const badges = document.createElement('span');
                            if (u.ip) {
                                const b = document.createElement('span');
                                b.className = 'badge bg-secondary me-1 font-monospace';
                                b.textContent = u.ip;
                                badges.appendChild(b);
                            }
                            if (u.isAdmin) {
                                const b = document.createElement('span');
                                b.className = 'badge bg-danger me-1';
                                b.textContent = 'Admin';
                                badges.appendChild(b);
                            }
                            if (u.isOwner) {
                                const b = document.createElement('span');
                                b.className = 'badge bg-warning text-dark me-1';
                                b.textContent = 'Owner';
                                badges.appendChild(b);
                            }
                            if (u.contextUser) {
                                const b = document.createElement('span');
                                b.className = 'badge bg-info text-white me-1';
                                b.textContent = u.contextUser;
                                badges.appendChild(b);
                            }
                            li.appendChild(badges);
                            list.appendChild(li);
                        });
                    }

                    resultDiv.classList.remove('d-none');
                } else {
                    toastr.error('Nie udało się pobrać sesji');
                }
            } catch (e) {
                toastr.error('Błąd połączenia z serwerem');
            }

            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i> Odśwież';
        });
    }

    // Translation dictionary sync
    const syncBtn = document.getElementById('btn-sync-translations');
    if (syncBtn) {
        syncBtn.addEventListener('click', async function () {
            const btn = this;
            const resultDiv = document.getElementById('translations-result');
            const progressDiv = document.getElementById('translations-progress');
            const summaryDiv = document.getElementById('translations-summary');
            const groupSyncDiv = document.getElementById('group-sync-status');

            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-hourglass-split me-1"></i> Synchronizacja...';
            resultDiv.classList.remove('d-none');
            progressDiv.innerHTML = '<div class="spinner-border spinner-border-sm text-warning me-2" role="status"></div> Trwa skanowanie katalogów...';
            summaryDiv.innerHTML = '';
            groupSyncDiv.innerHTML = '';

            try {
                const resp = await fetch('/admin/translations/sync', { method: 'POST' });
                const data = await resp.json();

                if (data.success) {
                    progressDiv.innerHTML = '';

                    if (data.groupSyncSuccess) {
                        groupSyncDiv.innerHTML = '<span class="badge bg-info fs-6"><i class="bi bi-check-circle me-1"></i>Działy i grupy zsynchronizowane</span>';
                    } else if (data.groupSyncSuccess === false) {
                        groupSyncDiv.innerHTML = '<span class="badge bg-warning fs-6"><i class="bi bi-exclamation-triangle me-1"></i>Sync grup: ' + (data.groupSyncError || 'błąd') + '</span>';
                    }

                    if (data.aliasesSyncSuccess) {
                        groupSyncDiv.innerHTML += ' <span class="badge bg-success fs-6"><i class="bi bi-check-circle me-1"></i>Aliasy klientów: ' + (data.aliasesTotal || 0) + ' wpisów</span>';
                    } else if (data.aliasesSyncSuccess === false) {
                        groupSyncDiv.innerHTML += ' <span class="badge bg-warning fs-6"><i class="bi bi-exclamation-triangle me-1"></i>Aliasy: ' + (data.aliasesSyncError || 'błąd') + '</span>';
                    }

                    let html = '<span class="badge bg-success fs-6 mb-2">Zsynchronizowano: ' + data.totalEntries + ' wpisów</span>';
                    html += '<ul class="list-group list-group-flush mt-2">';

                    data.groups.forEach(function (g) {
                        let statusBadge = '';
                        if (g.status === 'synced') {
                            statusBadge = '<span class="badge bg-primary">' + g.entries + ' wpisów</span>';
                        } else if (g.status === 'skipped') {
                            statusBadge = '<span class="badge bg-secondary">pominięta</span>';
                        } else {
                            statusBadge = '<span class="badge bg-warning">' + g.status + '</span>';
                        }
                        html += '<li class="list-group-item d-flex justify-content-between align-items-center">';
                        html += 'Grupa ' + g.groupNumber + (g.version ? ' (v' + g.version + ')' : '');
                        html += statusBadge + '</li>';
                    });

                    if (data.errors && data.errors.length > 0) {
                        data.errors.forEach(function (e) {
                            html += '<li class="list-group-item list-group-item-danger">';
                            html += 'Grupa ' + e.groupNumber + ': ' + e.error + '</li>';
                        });
                    }

                    html += '</ul>';
                    summaryDiv.innerHTML = html;
                } else {
                    progressDiv.innerHTML = '<span class="badge bg-danger">Błąd: ' + (data.message || 'Nieznany błąd') + '</span>';
                }
            } catch (e) {
                progressDiv.innerHTML = '<span class="badge bg-danger">Błąd połączenia z serwerem</span>';
            }

            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i> Synchronizuj';
        });
    }
});
