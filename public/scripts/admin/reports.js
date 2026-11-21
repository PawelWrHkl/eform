// ── Reports module frontend ───────────────────────────────────────
// Categories: overall | groups | dept-clients (+ org: winback | abc)
// Overall sub-views: table | bar | trend
// Groups sub-views:  groups-table | groups-chart
//
// Dwa tryby jednego pliku: admin (/admin/reports, teksty po polsku) i organizacja
// (/org/reports, `window.REPORTS_CFG` z routes/orgReports.js — adres API, waluta,
// kłódka, teksty `reports.*` z jezyki.xlsx).

const CFG = window.REPORTS_CFG || { mode: 'admin' };
const ORG = CFG.mode === 'org';
const API = ORG ? CFG.api : '/admin/api/reports';
const apiUrl = (path) => API + path + (CFG.orgQuery || '');
const NUM_LOCALE = CFG.numberLocale || 'pl-PL';

// Tekst UI: admin = polski tekst z kodu; organizacja = tłumaczenie `reports.<key>`.
function L(key, pl, vars) {
    let text = (ORG && typeof CFG.t?.[key] === 'string' && CFG.t[key]) || pl || key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return text;
}

let _currentStats = [];
let _currentTrend = [];
let _currentGroups = [];
let _currentDeptClients = [];
let _activeCategory = 'overall';
let _activeView = 'table';
let _sortCol = 'total_value';
let _sortDir = 'desc';
let _chartInstance = null;
let _activeMetrics = { value: true, orders: true, positions: false };
let _groupsMode = 'depts';        // 'depts' | 'groups'
let _selectedDeptIds = new Set(); // empty = all depts shown
let _activeDeptClientDeptId = null; // null = first dept
let _runSeq = 0;                    // guards against out-of-order responses
let _cur = '€';                     // symbol waluty raportu (org: z odpowiedzi API)
let _kpi = null;                    // org: kafelki KPI
let _winback = [];                  // org: klienci do odzyskania
let _seasonality = [];              // org: sprzedaż miesiąc × rok (cała historia)
let _abc = { clients: [], groups: [] }; // org: analiza ABC
let _offers = null;                 // org: raport ofert (null = baza bez order.offer_at)
let _unlocked = false;              // org: kłódka otwarta → zakup od HKL i marża
let _loaded = false;
const valueLabel = () => ORG ? L('col_sales', 'Sprzedaż ({cur})', { cur: _cur }) : 'Wartość (€)';

// ── Helpers ───────────────────────────────────────────────────────

function fmt(n) {
    return Number(n).toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n) {
    return Number(n).toLocaleString(NUM_LOCALE);
}

async function parseJsonResponse(res) {
    const contentType = res.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
        const body = await res.text();
        if (res.status === 401 || res.status === 403) {
            throw new Error(L('err_access', 'Brak dostępu do raportów albo sesja wygasła.'));
        }
        if (body && body.trim().startsWith('<')) {
            throw new Error(L('err_html', 'Endpoint raportów zwrócił HTML zamiast JSON. Sprawdź backend lub sesję użytkownika.'));
        }
        throw new Error(L('err_response', 'Nieprawidłowa odpowiedź serwera ({status}).', { status: res.status }));
    }

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.message || L('err_server', 'Błąd serwera ({status}).', { status: res.status }));
    }

    return data;
}

// ── Client list interaction ───────────────────────────────────────

function getSelectedIds() {
    return [...document.querySelectorAll('#client-list .client-list-item.selected')]
        .map(el => parseInt(el.dataset.id, 10));
}

function updateSelectionInfo() {
    const total = document.querySelectorAll('#client-list .client-list-item').length;
    const selected = getSelectedIds().length;
    document.getElementById('selected-count').textContent = selected;
}

// Bulk actions and loaded configs replace the selection, so quick filters no longer describe it.
function clearClientFilters() {
    document.querySelectorAll('#client-filters input:checked').forEach(cb => { cb.checked = false; });
}

function initClientList() {
    const list = document.getElementById('client-list');

    list.addEventListener('click', function (e) {
        if (e.target.type === 'checkbox') return; // handled by change event
        const item = e.target.closest('.client-list-item');
        if (!item) return;
        const cb = item.querySelector('input[type="checkbox"]');
        cb.checked = !cb.checked;
        item.classList.toggle('selected', cb.checked);
        updateSelectionInfo();
    });

    list.addEventListener('change', function (e) {
        if (e.target.type !== 'checkbox') return;
        const item = e.target.closest('.client-list-item');
        item.classList.toggle('selected', e.target.checked);
        updateSelectionInfo();
    });

    document.getElementById('btn-select-all').addEventListener('click', () => {
        document.querySelectorAll('#client-list .client-list-item').forEach(item => {
            const visible = item.style.display !== 'none';
            item.classList.toggle('selected', visible);
            item.querySelector('input[type="checkbox"]').checked = visible;
        });
        clearClientFilters();
        updateSelectionInfo();
    });

    document.getElementById('btn-deselect-all').addEventListener('click', () => {
        document.querySelectorAll('#client-list .client-list-item').forEach(item => {
            item.classList.remove('selected');
            item.querySelector('input[type="checkbox"]').checked = false;
        });
        clearClientFilters();
        updateSelectionInfo();
    });

    // Organization / group-client filters add up (union); none checked = all clients.
    document.getElementById('client-filters').addEventListener('change', () => {
        const checked = [...document.querySelectorAll('#client-filters input:checked')];
        const orgs = new Set(checked.map(cb => cb.dataset.filterOrg).filter(Boolean));
        const groups = checked.some(cb => cb.dataset.filterGroup);
        document.querySelectorAll('#client-list .client-list-item').forEach(item => {
            const sel = !checked.length || orgs.has(item.dataset.org) || (groups && !!item.dataset.group);
            item.classList.toggle('selected', sel);
            item.querySelector('input[type="checkbox"]').checked = sel;
        });
        updateSelectionInfo();
    });

    document.getElementById('client-search').addEventListener('input', function () {
        const q = this.value.toLowerCase();
        document.querySelectorAll('#client-list .client-list-item').forEach(item => {
            const match = item.dataset.ident.toLowerCase().includes(q)
                       || (item.dataset.name || '').toLowerCase().includes(q);
            item.style.display = match ? '' : 'none';
        });
    });
}

// ── Date range ────────────────────────────────────────────────────

// Reads the range straight from the inputs and keeps it consistent:
// „do zawsze aktualny" pins the upper bound to today, and a reversed
// range is swapped instead of silently returning nothing.
function currentRange() {
    const fromEl = document.getElementById('date-from');
    const toEl   = document.getElementById('date-to');

    if (document.getElementById('date-to-today').checked) {
        toEl.value = todayStr();
    }

    let dateFrom = fromEl.value || null;
    let dateTo   = toEl.value   || null;

    if (dateFrom && dateTo && dateFrom > dateTo) {
        [dateFrom, dateTo] = [dateTo, dateFrom];
        fromEl.value = dateFrom;
        toEl.value   = dateTo;
    }

    return { dateFrom, dateTo };
}

function updateRangeHint(dateFrom, dateTo) {
    const hint = document.getElementById('date-range-hint');
    if (!hint) return;
    hint.textContent = (!dateFrom && !dateTo)
        ? L('range_all', 'Bez ograniczenia — cała historia zamówień.')
        : `${L('range_all_views', 'Wszystkie widoki:')} ${dateFrom || L('range_start', 'początek')} → ${dateTo || L('range_today', 'dziś')}`;
}

function setRange(dateFrom, dateTo) {
    document.getElementById('date-from').value = dateFrom || '';
    document.getElementById('date-to').value   = dateTo   || '';
    document.getElementById('date-to-today').checked = false;
    runReport();
}

function initDateControls() {
    const fromEl = document.getElementById('date-from');
    const toEl   = document.getElementById('date-to');
    const todayCb = document.getElementById('date-to-today');

    // Any change to the range re-runs the whole report, so every view
    // (tabela, wykresy, trend, grupy, dział → klienci, licznik klientów)
    // always reflects the picked dates.
    [fromEl, toEl].forEach(el => el.addEventListener('change', () => {
        if (el === toEl) todayCb.checked = false;
        runReport();
    }));

    todayCb.addEventListener('change', () => {
        if (todayCb.checked) toEl.value = todayStr();
        runReport();
    });

    document.getElementById('date-presets')?.addEventListener('click', e => {
        const btn = e.target.closest('button[data-preset]');
        if (!btn) return;
        const now = new Date();
        const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const today = todayStr();

        switch (btn.dataset.preset) {
            case 'month':   setRange(iso(new Date(now.getFullYear(), now.getMonth(), 1)), today); break;
            case 'quarter': setRange(iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), today); break;
            case 'year':    setRange(`${now.getFullYear()}-01-01`, today); break;
            case '12m': {
                const past = new Date(now);
                past.setFullYear(past.getFullYear() - 1);
                setRange(iso(past), today);
                break;
            }
            case 'all':     setRange(null, null); break;
        }
    });
}

// ── Run report ────────────────────────────────────────────────────

async function runReport() {
    const ids = getSelectedIds();
    const { dateFrom, dateTo } = currentRange();
    updateRangeHint(dateFrom, dateTo);

    setLoading(true);

    const totalClients = document.querySelectorAll('#client-list .client-list-item').length;
    const userIds = ids.length > 0 && ids.length < totalClients ? ids : null;

    const runId = ++_runSeq;
    const currency = document.getElementById('report-currency')?.value || null;

    try {
        const res = await fetch(apiUrl('/stats'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ORG ? { userIds, dateFrom, dateTo, currency } : { userIds, dateFrom, dateTo }),
        });
        const data = await parseJsonResponse(res);
        if (runId !== _runSeq) return; // a newer range was requested meanwhile
        if (!data.success) throw new Error(data.message);

        _currentStats  = Array.isArray(data.stats)        ? data.stats        : [];
        _currentTrend  = Array.isArray(data.trend)        ? data.trend        : [];
        _currentGroups = Array.isArray(data.groups)       ? data.groups       : [];
        _currentDeptClients = Array.isArray(data.deptClients) ? data.deptClients : [];
        if (ORG) {
            _cur = data.currencySymbol || '€';
            _kpi = data.kpi || null;
            _winback = Array.isArray(data.winback) ? data.winback : [];
            _seasonality = Array.isArray(data.seasonality) ? data.seasonality : [];
            _abc = data.abc || { clients: [], groups: [] };
            _offers = data.offers || null;
            _unlocked = !!data.unlocked;
            _loaded = true;
        }
        updateClientCounts(data.clientCounts);
        updateSummary();
        renderActiveView();
        updateReportMeta(dateFrom, dateTo, ids.length);
    } catch (err) {
        if (runId !== _runSeq) return;
        showArea(`<div class="reports-empty text-danger"><i class="bi bi-exclamation-triangle me-2"></i>${err.message}</div>`);
    } finally {
        setLoading(false);
    }
}

// Sidebar order counters follow the selected range too — a client with no
// orders in the period is dimmed instead of showing its all-time total.
function updateClientCounts(clientCounts) {
    if (!Array.isArray(clientCounts)) return;
    const byId = new Map(clientCounts.map(c => [String(c.id), Number(c.order_count) || 0]));
    document.querySelectorAll('#client-list .client-list-item').forEach(item => {
        const count = byId.get(item.dataset.id) ?? 0;
        const badge = item.querySelector('.client-order-count');
        if (badge) badge.textContent = count;
        item.dataset.orderCount = count;
        item.classList.toggle('no-orders', count === 0);
    });
}

function setLoading(on) {
    if (on) {
        showArea(`<div class="reports-loading"><div class="spinner-border spinner-border-sm text-secondary"></div> ${L('loading', 'Ładowanie danych...')}</div>`);
        document.getElementById('summary-bar').style.display = 'none';
    }
}

function updateReportMeta(dateFrom, dateTo, clientCount) {
    let meta = `${clientCount} ${L('clients_count_suffix', 'klientów')}`;
    if (dateFrom || dateTo) meta += ` · ${dateFrom || '…'} → ${dateTo || '…'}`;
    document.getElementById('report-meta').textContent = meta;
}

function updateSummary() {
    if (ORG) return renderKpi();
    const bar = document.getElementById('summary-bar');
    bar.style.display = 'flex';

    const totalClients   = _currentStats.length;
    const totalOrders    = _currentStats.reduce((s, r) => s + Number(r.order_count),    0);
    const totalValue     = _currentStats.reduce((s, r) => s + Number(r.total_value),    0);
    const totalPositions = _currentStats.reduce((s, r) => s + Number(r.position_count), 0);

    document.getElementById('sum-clients').textContent   = fmtInt(totalClients);
    document.getElementById('sum-orders').textContent    = fmtInt(totalOrders);
    document.getElementById('sum-value').textContent     = fmt(totalValue) + ' €';
    document.getElementById('sum-positions').textContent = fmtInt(totalPositions);
}

// ── Views ─────────────────────────────────────────────────────────

function renderActiveView() {
    if (_activeView === 'table')             renderTable();
    else if (_activeView === 'bar')          renderBarChart();
    else if (_activeView === 'trend')        renderTrendChart();
    else if (_activeView === 'groups-table') renderGroupView();
    else if (_activeView === 'groups-chart') renderGroupBarChart();
    else if (_activeView === 'dc-table')     renderDeptClientsTable();
    else if (_activeView === 'dc-chart')     renderDeptClientsChart();
    else if (_activeView === 'winback')      renderWinback();
    else if (_activeView === 'abc-clients')  renderAbc('clients');
    else if (_activeView === 'abc-groups')   renderAbc('groups');
    else if (_activeView === 'season-table') renderSeasonality();
    else if (_activeView === 'offers')       renderOffers();
}

// ── Table view ────────────────────────────────────────────────────

// Kolumny tabeli klientów; w organizacji po otwarciu kłódki dochodzą zakup od HKL i marża.
function tableCols() {
    const cols = [
        { key: 'rank',           label: '#',                                   numeric: false, sortable: false },
        { key: 'ident',          label: L('col_client', 'Klient'),             numeric: false },
        { key: 'order_count',    label: L('metric_orders', 'Zamówienia'),      numeric: true,  metric: 'orders'    },
        { key: 'total_value',    label: valueLabel(),                          numeric: true,  metric: 'value'     },
        { key: 'position_count', label: L('metric_positions', 'Pozycje'),      numeric: true,  metric: 'positions' },
    ];
    if (ORG && _unlocked) {
        cols.push({ key: 'purchase_value', label: L('col_purchase', 'Zakup od HKL ({cur})', { cur: _cur }), numeric: true, metric: 'value' });
        cols.push({ key: 'margin_value',   label: L('col_margin', 'Marża ({cur})', { cur: _cur }),          numeric: true, metric: 'value' });
    }
    return cols;
}

function sortedStats() {
    const data = _currentStats.map(r => (ORG && _unlocked ? { ...r, margin_value: Number(r.total_value) - Number(r.purchase_value) } : r));
    data.sort((a, b) => {
        const av = isNaN(a[_sortCol]) ? a[_sortCol] : Number(a[_sortCol]);
        const bv = isNaN(b[_sortCol]) ? b[_sortCol] : Number(b[_sortCol]);
        if (av < bv) return _sortDir === 'asc' ? -1 : 1;
        if (av > bv) return _sortDir === 'asc' ?  1 : -1;
        return 0;
    });
    return data;
}

function renderTable() {
    if (!_currentStats.length) {
        showArea(`<div class="reports-empty">${L('no_data_filters', 'Brak danych dla wybranych filtrów.')}</div>`);
        return;
    }

    const rows = sortedStats();
    const cols = tableCols().filter(c => !c.metric || _activeMetrics[c.metric]);

    const thead = cols.map(c => {
        if (c.sortable === false) return `<th>${c.label}</th>`;
        const cls = [_sortCol === c.key ? (_sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '', c.numeric ? 'num' : ''].filter(Boolean).join(' ');
        return `<th class="${cls}" data-col="${c.key}">${c.label}<span class="sort-icon"></span></th>`;
    }).join('');

    const tbody = rows.map((r, idx) => {
        const rankCls = idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : '';
        const cells = cols.map(c => {
            if (c.key === 'rank')           return `<td><span class="rank-badge ${rankCls}">${idx + 1}</span></td>`;
            if (c.key === 'ident')          return `<td><div style="font-weight:600;">${escHtml(r.ident)}</div><div style="font-size:0.75rem;color:var(--text-muted,#6c757d);">${escHtml(r.client_name || '')}</div></td>`;
            if (c.key === 'order_count')    return `<td class="num">${fmtInt(r.order_count)}</td>`;
            if (c.key === 'total_value')    return `<td class="num">${fmt(r.total_value)}</td>`;
            if (c.key === 'position_count') return `<td class="num">${fmtInt(r.position_count)}</td>`;
            if (c.key === 'purchase_value') return `<td class="num">${fmt(r.purchase_value)}</td>`;
            if (c.key === 'margin_value')   return `<td class="num">${fmt(r.margin_value)}</td>`;
            return '<td></td>';
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    const html = `
        <div class="report-table-wrap">
            <table class="report-table">
                <thead><tr>${thead}</tr></thead>
                <tbody>${tbody}</tbody>
            </table>
        </div>`;
    showArea(html);

    // Sort click handlers
    document.querySelectorAll('.report-table thead th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (_sortCol === col) {
                _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _sortCol = col;
                _sortDir = 'desc';
            }
            renderTable();
        });
    });
}

// ── Group filter helpers ──────────────────────────────────────────

function allDepts() {
    const map = {};
    _currentGroups.forEach(r => { map[r.department_id] = r.department_name; });
    return Object.entries(map).sort((a, b) => a[1].localeCompare(b[1], NUM_LOCALE));
}

function filteredGroupRows() {
    if (_selectedDeptIds.size === 0) return _currentGroups;
    return _currentGroups.filter(r => _selectedDeptIds.has(String(r.department_id)));
}

function buildGroupsFilterBar() {
    const depts = allDepts();
    const deptCheckboxes = depts.map(([id, name]) => {
        const checked = _selectedDeptIds.size === 0 || _selectedDeptIds.has(String(id)) ? 'checked' : '';
        return `<label class="gf-dept-item">
            <input type="checkbox" class="gf-dept-cb" data-dept-id="${id}" ${checked}>
            <span>${escHtml(name)}</span>
        </label>`;
    }).join('');

    const deptPanel = `<div class="gf-dept-list" id="gf-dept-list" style="${_groupsMode === 'depts' ? '' : ''}">
        <div class="gf-dept-selrow">
            <button class="btn btn-xs btn-outline-secondary btn-sm py-0" id="gf-select-all-depts">${L('all_depts', 'Wszystkie')}</button>
            <button class="btn btn-xs btn-outline-secondary btn-sm py-0" id="gf-deselect-all-depts">${L('deselect', 'Odznacz')}</button>
        </div>
        ${deptCheckboxes}
    </div>`;

    return `<div class="groups-filter-bar" id="groups-filter-bar">
        <div class="gf-mode-toggle">
            <button class="${_groupsMode === 'depts' ? 'active' : ''}" data-gmode="depts">
                <i class="bi bi-building me-1"></i>${L('mode_depts', 'Całe działy')}
            </button>
            <button class="${_groupsMode === 'groups' ? 'active' : ''}" data-gmode="groups">
                <i class="bi bi-grid-3x3-gap me-1"></i>${L('mode_groups', 'Konkretne grupy')}
            </button>
        </div>
        <div class="gf-dept-section">${deptPanel}</div>
    </div>`;
}

function initGroupsFilterBar() {
    const bar = document.getElementById('groups-filter-bar');
    if (!bar) return;

    // Mode toggle
    bar.querySelectorAll('.gf-mode-toggle button').forEach(btn => {
        btn.addEventListener('click', () => {
            _groupsMode = btn.dataset.gmode;
            renderActiveView();
        });
    });

    // Dept checkboxes
    bar.querySelectorAll('.gf-dept-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            // Rebuild selection from current checkboxes
            _selectedDeptIds.clear();
            const allCbs = bar.querySelectorAll('.gf-dept-cb');
            const unchecked = [...allCbs].filter(c => !c.checked);
            if (unchecked.length > 0) {
                allCbs.forEach(c => { if (c.checked) _selectedDeptIds.add(c.dataset.deptId); });
            }
            renderActiveView();
        });
    });

    document.getElementById('gf-select-all-depts').addEventListener('click', () => {
        _selectedDeptIds.clear();
        renderActiveView();
    });

    document.getElementById('gf-deselect-all-depts').addEventListener('click', () => {
        // Keep only first dept checked to avoid empty state
        const first = bar.querySelector('.gf-dept-cb');
        if (first) _selectedDeptIds = new Set([first.dataset.deptId]);
        renderActiveView();
    });
}

// ── Group view ────────────────────────────────────────────────────

function renderGroupView() {
    if (!_currentGroups || !_currentGroups.length) {
        showArea(`<div class="reports-empty">${L('no_group_data', 'Brak danych grup dla wybranych filtrów.')}</div>`);
        return;
    }

    const showValue    = _activeMetrics.value;
    const showOrders   = _activeMetrics.orders;
    const showPos      = _activeMetrics.positions;

    const filterBar = buildGroupsFilterBar();
    const rows = filteredGroupRows();

    let tableHtml = '';

    if (_groupsMode === 'depts') {
        // Aggregate to department level only
        const byDept = {};
        rows.forEach(r => {
            const k = r.department_id + '|' + r.department_name;
            if (!byDept[k]) byDept[k] = { name: r.department_name, totPos: 0, totVal: 0, totOrd: 0, totClients: 0 };
            byDept[k].totPos += Number(r.position_count);
            byDept[k].totVal += Number(r.total_value);
            byDept[k].totOrd += Number(r.order_count);
        });

        const colHeaders = [{ label: L('col_dept', 'Dział'), num: false }];
        if (showPos)    colHeaders.push({ label: L('metric_positions', 'Pozycje'),    num: true });
        if (showOrders) colHeaders.push({ label: L('metric_orders', 'Zamówienia'), num: true });
        if (showValue)  colHeaders.push({ label: valueLabel(), num: true });

        const bodyRows = Object.values(byDept)
            .sort((a, b) => b.totVal - a.totVal)
            .map(d => {
                const cells = [`<td><strong>${escHtml(d.name)}</strong></td>`];
                if (showPos)    cells.push(`<td class="num">${fmtInt(d.totPos)}</td>`);
                if (showOrders) cells.push(`<td class="num">${fmtInt(d.totOrd)}</td>`);
                if (showValue)  cells.push(`<td class="num">${fmt(d.totVal)}</td>`);
                return `<tr>${cells.join('')}</tr>`;
            }).join('');

        tableHtml = `<div class="report-table-wrap">
            <table class="report-table">
                <thead><tr>${colHeaders.map(h => `<th${h.num ? ' class="num"' : ''}>${h.label}</th>`).join('')}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>`;
    } else {
        // Group by department, show groups within
        const byDept = {};
        rows.forEach(r => {
            const dk = r.department_id + '|' + r.department_name;
            if (!byDept[dk]) byDept[dk] = { name: r.department_name, rows: [], totPos: 0, totVal: 0, totOrd: 0 };
            byDept[dk].rows.push(r);
            byDept[dk].totPos += Number(r.position_count);
            byDept[dk].totVal += Number(r.total_value);
            byDept[dk].totOrd += Number(r.order_count);
        });

        const colHeaders = [{ label: L('col_group', 'Grupa'), num: false }];
        if (showPos)    colHeaders.push({ label: L('metric_positions', 'Pozycje'),    num: true });
        if (showOrders) colHeaders.push({ label: L('metric_orders', 'Zamówienia'), num: true });
        if (showValue)  colHeaders.push({ label: valueLabel(), num: true });

        Object.values(byDept).forEach(dept => {
            const deptPos = showPos    ? `<span class="dept-stat">${fmtInt(dept.totPos)} ${L('pos_short', 'poz.')}</span>` : '';
            const deptOrd = showOrders ? `<span class="dept-stat">${fmtInt(dept.totOrd)} ${L('ord_short', 'zam.')}</span>` : '';
            const deptVal = showValue  ? `<span class="dept-stat">${fmt(dept.totVal)} ${_cur}</span>` : '';

            const bodyRows = dept.rows.map(r => {
                const cells = ['<td>' + escHtml(r.group_name) + '</td>'];
                if (showPos)    cells.push(`<td class="num">${fmtInt(r.position_count)}</td>`);
                if (showOrders) cells.push(`<td class="num">${fmtInt(r.order_count)}</td>`);
                if (showValue)  cells.push(`<td class="num">${fmt(r.total_value)}</td>`);
                return `<tr>${cells.join('')}</tr>`;
            }).join('');

            tableHtml += `
            <div class="dept-section">
                <div class="dept-header">
                    <span class="dept-name">${escHtml(dept.name)}</span>
                    <span class="dept-stats">${deptPos}${deptOrd}${deptVal}</span>
                </div>
                <div class="report-table-wrap">
                    <table class="report-table">
                        <thead><tr>${colHeaders.map(h => `<th${h.num ? ' class="num"' : ''}>${h.label}</th>`).join('')}</tr></thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>`;
        });
    }

    showArea(`${filterBar}<div class="group-view">${tableHtml}</div>`);
    initGroupsFilterBar();
}

// ── Group bar chart ───────────────────────────────────────────────

function renderGroupBarChart() {
    if (!_currentGroups || !_currentGroups.length) {
        showArea(`<div class="reports-empty">${L('no_group_data', 'Brak danych grup dla wybranych filtrów.')}</div>`);
        return;
    }

    destroyChart();
    const filterBar = buildGroupsFilterBar();
    const chartHtml = `${filterBar}<div class="chart-container"><canvas id="report-chart"></canvas></div>`;
    showArea(chartHtml);
    initGroupsFilterBar();

    const rows = filteredGroupRows();
    const sortKey = _activeMetrics.value ? 'val' : _activeMetrics.orders ? 'ord' : 'pos';

    let labels, vals, ords, pos, depts;

    if (_groupsMode === 'depts') {
        // Aggregate to department level
        const byDept = {};
        rows.forEach(r => {
            const k = r.department_name;
            if (!byDept[k]) byDept[k] = { label: r.department_name, pos: 0, val: 0, ord: 0 };
            byDept[k].pos += Number(r.position_count);
            byDept[k].val += Number(r.total_value);
            byDept[k].ord += Number(r.order_count);
        });
        const top = Object.values(byDept).sort((a, b) => b[sortKey] - a[sortKey]);
        labels = top.map(r => r.label);
        vals   = top.map(r => r.val);
        ords   = top.map(r => r.ord);
        pos    = top.map(r => r.pos);
        depts  = null;
    } else {
        // Group level — top 30
        const byGroup = {};
        rows.forEach(r => {
            const k = r.group_name;
            if (!byGroup[k]) byGroup[k] = { group: r.group_name, dept: r.department_name, pos: 0, val: 0, ord: 0 };
            byGroup[k].pos += Number(r.position_count);
            byGroup[k].val += Number(r.total_value);
            byGroup[k].ord += Number(r.order_count);
        });
        const top = Object.values(byGroup).sort((a, b) => b[sortKey] - a[sortKey]).slice(0, 30);
        labels = top.map(r => r.group);
        vals   = top.map(r => r.val);
        ords   = top.map(r => r.ord);
        pos    = top.map(r => r.pos);
        depts  = top.map(r => r.dept);
    }

    const hasValue  = _activeMetrics.value;
    const hasOrders = _activeMetrics.orders;
    const hasPos    = _activeMetrics.positions;
    const countAxis = hasValue ? 'y2' : 'y';

    const datasets = [];
    if (hasValue)  datasets.push({ label: valueLabel(), money: true, data: vals, backgroundColor: 'rgba(13,110,253,0.7)',  borderRadius: 4, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: L('metric_orders', 'Zamówienia'),  data: ords, backgroundColor: 'rgba(25,135,84,0.7)',   borderRadius: 4, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: L('metric_positions', 'Pozycje'),     data: pos,  backgroundColor: 'rgba(255,193,7,0.7)',   borderRadius: 4, yAxisID: countAxis });

    const scales = {
        x: { ticks: { maxRotation: 45, font: { size: 11 } } },
        y: { position: 'left', title: { display: true, text: hasValue ? valueLabel() : L('axis_qty', 'Ilość') } }
    };
    if ((hasOrders || hasPos) && hasValue) {
        scales.y2 = { position: 'right', title: { display: true, text: L('axis_qty', 'Ilość') }, grid: { drawOnChartArea: false } };
    }

    const ctx = document.getElementById('report-chart').getContext('2d');
    _chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        afterTitle: depts ? (items => '📂 ' + depts[items[0].dataIndex]) : undefined,
                        label: c => c.dataset.label + ': ' + (c.dataset.money ? fmt(c.parsed.y) + ' ' + _cur : fmtInt(c.parsed.y)),
                    }
                }
            },
            scales,
        }
    });
}

// ── Dept-clients helpers ──────────────────────────────────────────

function getDeptClientDepts() {
    const map = {};
    _currentDeptClients.forEach(r => {
        if (!map[r.department_id]) map[r.department_id] = { id: r.department_id, name: r.department_name };
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name, NUM_LOCALE));
}

function getActiveDeptClientDept(depts) {
    if (_activeDeptClientDeptId !== null) {
        const found = depts.find(d => String(d.id) === String(_activeDeptClientDeptId));
        if (found) return found;
    }
    return depts[0] || { id: 0, name: '—' };
}

function buildDeptClientDeptBar(depts, activeDept) {
    const btns = depts.map(d => {
        const active = String(d.id) === String(activeDept.id) ? 'active' : '';
        return `<button class="dc-dept-btn ${active}" data-dept-id="${d.id}">${escHtml(d.name)}</button>`;
    }).join('');
    return `<div class="dc-dept-bar" id="dc-dept-bar">${btns}</div>`;
}

function initDeptClientDeptBar() {
    const bar = document.getElementById('dc-dept-bar');
    if (!bar) return;
    bar.querySelectorAll('.dc-dept-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeDeptClientDeptId = btn.dataset.deptId;
            renderActiveView();
        });
    });
}

// ── Dept-clients table view ───────────────────────────────────────

function renderDeptClientsTable() {
    if (!_currentDeptClients || !_currentDeptClients.length) {
        showArea(`<div class="reports-empty">${L('no_data_filters', 'Brak danych dla wybranych filtrów.')}</div>`);
        return;
    }

    const depts = getDeptClientDepts();
    const activeDept = getActiveDeptClientDept(depts);
    const deptBar = buildDeptClientDeptBar(depts, activeDept);

    const showValue  = _activeMetrics.value;
    const showOrders = _activeMetrics.orders;
    const showPos    = _activeMetrics.positions;

    const rows = _currentDeptClients
        .filter(r => String(r.department_id) === String(activeDept.id))
        .sort((a, b) => Number(b.total_value) - Number(a.total_value));

    if (!rows.length) {
        showArea(deptBar + `<div class="reports-empty">${L('no_dept_clients', 'Brak klientów w tym dziale.')}</div>`);
        initDeptClientDeptBar();
        return;
    }

    const colHeaders = [{ label: '#', num: false }, { label: L('col_client', 'Klient'), num: false }];
    if (showPos)    colHeaders.push({ label: L('metric_positions', 'Pozycje'),     num: true });
    if (showOrders) colHeaders.push({ label: L('metric_orders', 'Zamówienia'),  num: true });
    if (showValue)  colHeaders.push({ label: valueLabel(), num: true });

    const maxVal = Math.max(...rows.map(r => Number(r.total_value)), 1);

    const tbody = rows.map((r, idx) => {
        const rankCls = idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : '';
        const pct = Math.round((Number(r.total_value) / maxVal) * 100);
        const cells = [
            `<td><span class="rank-badge ${rankCls}">${idx + 1}</span></td>`,
            `<td>
                <div style="font-weight:600;">${escHtml(r.ident)}</div>
                <div style="font-size:0.75rem;color:var(--text-muted,#6c757d);">${escHtml(r.client_name || '')}</div>
                ${showValue ? `<div class="dc-bar-wrap"><div class="dc-bar" style="width:${pct}%"></div></div>` : ''}
             </td>`,
        ];
        if (showPos)    cells.push(`<td class="num">${fmtInt(r.position_count)}</td>`);
        if (showOrders) cells.push(`<td class="num">${fmtInt(r.order_count)}</td>`);
        if (showValue)  cells.push(`<td class="num">${fmt(r.total_value)}</td>`);
        return `<tr>${cells.join('')}</tr>`;
    }).join('');

    const thead = colHeaders.map(h => `<th${h.num ? ' class="num"' : ''}>${h.label}</th>`).join('');
    const tableHtml = `<div class="report-table-wrap">
        <table class="report-table">
            <thead><tr>${thead}</tr></thead>
            <tbody>${tbody}</tbody>
        </table>
    </div>`;

    showArea(`${deptBar}<div class="group-view">${tableHtml}</div>`);
    initDeptClientDeptBar();
}

// ── Dept-clients bar chart ────────────────────────────────────────

function renderDeptClientsChart() {
    if (!_currentDeptClients || !_currentDeptClients.length) {
        showArea(`<div class="reports-empty">${L('no_data_filters', 'Brak danych dla wybranych filtrów.')}</div>`);
        return;
    }

    destroyChart();
    const depts = getDeptClientDepts();
    const activeDept = getActiveDeptClientDept(depts);
    const deptBar = buildDeptClientDeptBar(depts, activeDept);

    showArea(`${deptBar}<div class="chart-container"><canvas id="report-chart"></canvas></div>`);
    initDeptClientDeptBar();

    const sortKey = _activeMetrics.value ? 'total_value' : _activeMetrics.orders ? 'order_count' : 'position_count';
    const rows = _currentDeptClients
        .filter(r => String(r.department_id) === String(activeDept.id))
        .sort((a, b) => Number(b[sortKey]) - Number(a[sortKey]));

    if (!rows.length) return;

    const labels = rows.map(r => r.ident);
    const vals   = rows.map(r => Number(r.total_value));
    const ords   = rows.map(r => Number(r.order_count));
    const pos    = rows.map(r => Number(r.position_count));

    const hasValue  = _activeMetrics.value;
    const hasOrders = _activeMetrics.orders;
    const hasPos    = _activeMetrics.positions;
    const countAxis = hasValue ? 'y2' : 'y';

    const datasets = [];
    if (hasValue)  datasets.push({ label: valueLabel(), money: true, data: vals, backgroundColor: 'rgba(13,110,253,0.7)',  borderRadius: 4, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: L('metric_orders', 'Zamówienia'),  data: ords, backgroundColor: 'rgba(25,135,84,0.7)',   borderRadius: 4, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: L('metric_positions', 'Pozycje'),     data: pos,  backgroundColor: 'rgba(255,193,7,0.7)',   borderRadius: 4, yAxisID: countAxis });

    const scales = {
        x: { ticks: { maxRotation: 45, font: { size: 11 } } },
        y: { position: 'left', title: { display: true, text: hasValue ? valueLabel() : L('axis_qty', 'Ilość') } }
    };
    if ((hasOrders || hasPos) && hasValue) {
        scales.y2 = { position: 'right', title: { display: true, text: L('axis_qty', 'Ilość') }, grid: { drawOnChartArea: false } };
    }

    const ctx = document.getElementById('report-chart').getContext('2d');
    _chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: c => c.dataset.label + ': ' + (c.dataset.money ? fmt(c.parsed.y) + ' ' + _cur : fmtInt(c.parsed.y)),
                    }
                }
            },
            scales,
        }
    });
}

// ── Bar chart ─────────────────────────────────────────────────────

function renderBarChart() {
    if (!_currentStats.length) {
        showArea(`<div class="reports-empty">${L('no_data', 'Brak danych.')}</div>`);
        return;
    }

    destroyChart();
    const top = [..._currentStats]
        .sort((a, b) => Number(b.total_value) - Number(a.total_value))
        .slice(0, 25);

    const html = `<div class="chart-container"><canvas id="report-chart"></canvas></div>`;
    showArea(html);

    const ctx = document.getElementById('report-chart').getContext('2d');
    const hasValue  = _activeMetrics.value;
    const hasOrders = _activeMetrics.orders;
    const hasPos    = _activeMetrics.positions;
    const countAxis = hasValue ? 'y2' : 'y';

    const datasets = [];
    if (hasValue)  datasets.push({ label: valueLabel(), money: true, data: top.map(r => Number(r.total_value)),    backgroundColor: 'rgba(13,110,253,0.7)', borderRadius: 4, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: L('metric_orders', 'Zamówienia'),  data: top.map(r => Number(r.order_count)),    backgroundColor: 'rgba(25,135,84,0.7)',  borderRadius: 4, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: L('metric_positions', 'Pozycje'),     data: top.map(r => Number(r.position_count)), backgroundColor: 'rgba(255,193,7,0.7)',  borderRadius: 4, yAxisID: countAxis });

    const scales = { x: { ticks: { maxRotation: 45, font: { size: 11 } } }, y: { position: 'left', title: { display: true, text: hasValue ? valueLabel() : L('axis_qty', 'Ilość') } } };
    if ((hasOrders || hasPos) && hasValue) scales.y2 = { position: 'right', title: { display: true, text: L('axis_qty', 'Ilość') }, grid: { drawOnChartArea: false } };

    _chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels: top.map(r => r.ident), datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: { callbacks: { label: c => c.dataset.label + ': ' + (c.dataset.money ? fmt(c.parsed.y) + ' ' + _cur : fmtInt(c.parsed.y)) } }
            },
            scales,
        }
    });
}

// ── Trend chart ───────────────────────────────────────────────────

function renderTrendChart() {
    if (!_currentTrend.length) {
        showArea(`<div class="reports-empty">${L('no_trend', 'Brak danych trendu.')}</div>`);
        return;
    }

    destroyChart();
    const html = `<div class="chart-container"><canvas id="report-chart"></canvas></div>`;
    showArea(html);

    const ctx = document.getElementById('report-chart').getContext('2d');
    const hasValue  = _activeMetrics.value;
    const hasOrders = _activeMetrics.orders;
    const hasPos    = _activeMetrics.positions;
    const countAxis = hasValue ? 'y2' : 'y';

    const datasets = [];
    if (hasValue)  datasets.push({ label: valueLabel(), money: true, data: _currentTrend.map(r => Number(r.total_value)),    borderColor: 'rgba(13,110,253,1)', backgroundColor: 'rgba(13,110,253,0.1)', fill: true,  tension: 0.3, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: L('metric_orders', 'Zamówienia'),  data: _currentTrend.map(r => Number(r.order_count)),    borderColor: 'rgba(25,135,84,1)',  backgroundColor: 'rgba(25,135,84,0.08)', fill: false, tension: 0.3, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: L('metric_positions', 'Pozycje'),     data: _currentTrend.map(r => Number(r.position_count)), borderColor: 'rgba(255,193,7,1)',  backgroundColor: 'rgba(255,193,7,0.08)', fill: false, tension: 0.3, yAxisID: countAxis });

    const scales = { y: { position: 'left', title: { display: true, text: hasValue ? valueLabel() : L('axis_qty', 'Ilość') } } };
    if ((hasOrders || hasPos) && hasValue) scales.y2 = { position: 'right', title: { display: true, text: L('axis_qty', 'Ilość') }, grid: { drawOnChartArea: false } };

    _chartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: _currentTrend.map(r => r.month), datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales,
        }
    });
}

// ── Saved configs ─────────────────────────────────────────────────

function initConfigControls() {
    document.getElementById('btn-save-config').addEventListener('click', async () => {
        const name = document.getElementById('config-name-input').value.trim();
        if (!name) { alert(L('config_name_required', 'Wpisz nazwę konfiguracji.')); return; }
        const ids = getSelectedIds();
        const { dateFrom, dateTo } = currentRange();
        const dateToToday = document.getElementById('date-to-today').checked;

        const res = await fetch(apiUrl('/configs'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, userIds: ids, dateFrom, dateTo, dateToToday }),
        });
        const data = await parseJsonResponse(res);
        if (data.success) {
            renderSavedConfigs(data.configs);
            document.getElementById('config-name-input').value = '';
        }
    });

    document.getElementById('config-list').addEventListener('click', async (e) => {
        // Delete button
        if (e.target.classList.contains('config-delete-btn')) {
            e.stopPropagation();
            const name = e.target.dataset.name;
            if (!confirm(L('config_delete_confirm', 'Usunąć konfigurację „{name}"?', { name }))) return;
            const res = await fetch(API + '/configs/' + encodeURIComponent(name) + (CFG.orgQuery || ''), {
                method: 'DELETE', credentials: 'include',
            });
            const data = await parseJsonResponse(res);
            if (data.success) renderSavedConfigs(data.configs);
            return;
        }
        // Load config
        const item = e.target.closest('.config-item');
        if (!item) return;
        const cfg = JSON.parse(item.dataset.config);
        loadConfig(cfg);
    });
}

function loadConfig(cfg) {
    // Set dates
    document.getElementById('date-from').value = cfg.dateFrom || '';
    document.getElementById('date-to').value   = cfg.dateToToday ? todayStr() : (cfg.dateTo || '');
    document.getElementById('date-to-today').checked = !!cfg.dateToToday;

    // Set client selection
    const ids = new Set((cfg.userIds || []).map(Number));
    document.querySelectorAll('#client-list .client-list-item').forEach(item => {
        const sel = ids.size === 0 || ids.has(parseInt(item.dataset.id, 10));
        const cb = item.querySelector('input[type="checkbox"]');
        cb.checked = sel;
        item.classList.toggle('selected', sel);
    });
    clearClientFilters();
    updateSelectionInfo();
    runReport();
}

function renderSavedConfigs(configs) {
    const card = document.getElementById('saved-configs-card');
    const list = document.getElementById('config-list');
    list.innerHTML = '';

    if (!configs || configs.length === 0) {
        card.style.display = 'none';
        return;
    }
    card.style.display = '';

    configs.forEach(cfg => {
        const item = document.createElement('div');
        item.className = 'config-item';
        item.dataset.config = JSON.stringify(cfg);
        const clientsLabel = cfg.userIds?.length ? cfg.userIds.length + ' ' + L('clients_count_suffix', 'klientów') : L('all_clients', 'wszyscy');
        const today = L('today', 'dzisiaj');
        const dateLabel = cfg.dateFrom
            ? `${cfg.dateFrom} → ${cfg.dateToToday ? today : (cfg.dateTo || '…')}`
            : (cfg.dateToToday ? '→ ' + today : '');
        item.innerHTML = `
            <div>
                <div class="config-name">${escHtml(cfg.name)}</div>
                <div class="config-meta">${clientsLabel}${dateLabel ? ' · ' + dateLabel : ''}</div>
            </div>
            <button class="config-delete-btn" data-name="${escHtml(cfg.name)}" title="${escHtml(L('delete', 'Usuń'))}">×</button>`;
        list.appendChild(item);
    });

    // Update collapsible body max-height if currently open
    const header = document.getElementById('saved-configs-toggle');
    const body = header?.nextElementSibling;
    if (body && !body.classList.contains('collapsed') && body.style.maxHeight !== 'none') {
        body.style.maxHeight = body.scrollHeight + 'px';
    }
}

// ── Category + View toggle ────────────────────────────────────────

function initViewToggle() {
    // Category (top level)
    document.getElementById('category-toggle').addEventListener('click', e => {
        const btn = e.target.closest('button[data-category]');
        if (!btn) return;
        _activeCategory = btn.dataset.category;

        document.querySelectorAll('#category-toggle button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Show/hide sub-view buttons
        document.querySelectorAll('#view-toggle button[data-category]').forEach(b => {
            b.style.display = b.dataset.category === _activeCategory ? '' : 'none';
        });

        // Activate first visible sub-view
        const first = document.querySelector(`#view-toggle button[data-category="${_activeCategory}"]`);
        if (first) {
            document.querySelectorAll('#view-toggle button').forEach(b => b.classList.remove('active'));
            first.classList.add('active');
            _activeView = first.dataset.view;
        }

        if (_currentStats.length || _currentGroups.length || _loaded) renderActiveView();
    });

    // Sub-view (second level)
    document.getElementById('view-toggle').addEventListener('click', e => {
        const btn = e.target.closest('button[data-view]');
        if (!btn || btn.style.display === 'none') return;
        document.querySelectorAll('#view-toggle button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _activeView = btn.dataset.view;
        if (_currentStats.length || _currentGroups.length || _loaded) renderActiveView();
    });
}

// ── Utils ─────────────────────────────────────────────────────────

function showArea(html) {
    if (ORG) destroyChart(); // wykres znika z ekranu razem z kontenerem (eksport nie bierze starego)
    document.getElementById('report-area').innerHTML = html;
}

function destroyChart() {
    if (_chartInstance) {
        _chartInstance.destroy();
        _chartInstance = null;
    }
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function todayStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

// ── Metric toggle ─────────────────────────────────────────────────

function initMetricToggles() {
    document.getElementById('metric-toggle').addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-metric]');
        if (!btn) return;
        const metric = btn.dataset.metric;
        const next = !_activeMetrics[metric];
        if (!next && Object.values(_activeMetrics).filter(Boolean).length === 1) return; // keep at least one
        _activeMetrics[metric] = next;
        btn.classList.toggle('active', next);
        if (_currentStats.length || _currentTrend.length || _loaded) renderActiveView();
    });
}

// ── Collapsible cards ─────────────────────────────────────────────

const LS_PREFIX = 'reports_collapsible_';

function initCollapsible() {
    document.querySelectorAll('.collapsible-header').forEach(header => {
        const body = header.nextElementSibling;
        if (!body) return;

        const key = header.dataset.key;
        // Read saved state; default from data-default (fallback = collapsed)
        const saved = key ? localStorage.getItem(LS_PREFIX + key) : null;
        const startOpen = saved ? saved === 'open' : header.dataset.default === 'open';

        if (startOpen) {
            body.classList.remove('collapsed');
            body.style.maxHeight = 'none';
            header.setAttribute('aria-expanded', 'true');
        } else {
            body.classList.add('collapsed');
            body.style.maxHeight = '0';
            header.setAttribute('aria-expanded', 'false');
        }

        header.addEventListener('click', () => {
            const expanded = header.getAttribute('aria-expanded') === 'true';
            if (expanded) {
                body.style.maxHeight = body.scrollHeight + 'px';
                requestAnimationFrame(() => {
                    body.classList.add('collapsed');
                    body.style.maxHeight = '0';
                });
                header.setAttribute('aria-expanded', 'false');
                if (key) localStorage.setItem(LS_PREFIX + key, 'closed');
            } else {
                body.classList.remove('collapsed');
                body.style.maxHeight = body.scrollHeight + 'px';
                header.setAttribute('aria-expanded', 'true');
                if (key) localStorage.setItem(LS_PREFIX + key, 'open');
                body.addEventListener('transitionend', () => {
                    if (header.getAttribute('aria-expanded') === 'true') {
                        body.style.maxHeight = 'none';
                    }
                }, { once: true });
            }
        });
    });
}

// ── Organizacja: KPI, klienci do odzyskania, ABC, eksport, wydruk ──

const pct = (v, digits = 1) => (v * 100).toLocaleString(NUM_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' %';

// Δ% bieżącej wartości do porównania; brak bazy (0) albo brak okresu = „—”.
function deltaHtml(cur, base, label) {
    if (base === undefined || base === null) return '';
    if (!Number(base)) return `<div class="kpi-delta neutral">${escHtml(label)}: —</div>`;
    const d = (Number(cur) - Number(base)) / Math.abs(Number(base));
    const dir = d > 0.0005 ? 'up' : d < -0.0005 ? 'down' : 'neutral';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
    const sign = d > 0 ? '+' : '';
    return `<div class="kpi-delta ${dir}">${arrow} ${sign}${pct(d)} <span class="kpi-delta-label">${escHtml(label)}</span></div>`;
}

function renderKpi() {
    const bar = document.getElementById('kpi-bar');
    if (!bar || !_kpi) return;
    const c = _kpi.current || {};
    const tiles = [
        { key: 'sales',     label: L('kpi_sales', 'Sprzedaż'),                    money: true },
        { key: 'orders',    label: L('kpi_orders', 'Zlecenia') },
        { key: 'positions', label: L('kpi_positions', 'Pozycje') },
        { key: 'avgOrder',  label: L('kpi_avg_order', 'Średnia wartość zlecenia'), money: true },
        { key: 'clients',   label: L('kpi_clients', 'Aktywni klienci') },
    ];
    if (_unlocked && c.purchase !== undefined) {
        tiles.push({ key: 'purchase', label: L('kpi_purchase', 'Zakup od HKL'), money: true });
        tiles.push({ key: 'margin',   label: L('kpi_margin', 'Marża'),          money: true, share: c.sales ? c.margin / c.sales : null });
    }
    const range = (r) => r ? `${r.dateFrom} → ${r.dateTo}` : '';
    bar.innerHTML = tiles.map(t => `
        <div class="kpi-tile">
            <div class="kpi-label">${escHtml(t.label)}</div>
            <div class="kpi-value">${t.money ? fmt(c[t.key] || 0) + ' ' + escHtml(_cur) : fmtInt(c[t.key] || 0)}${t.share != null ? ` <span class="kpi-share">${pct(t.share)}</span>` : ''}</div>
            <div title="${escHtml(range(_kpi.ranges?.prev))}">${_kpi.prev ? deltaHtml(c[t.key], _kpi.prev[t.key], L('kpi_vs_prev', 'vs poprzedni okres')) : ''}</div>
            <div title="${escHtml(range(_kpi.ranges?.yoy))}">${_kpi.yoy ? deltaHtml(c[t.key], _kpi.yoy[t.key], L('kpi_vs_yoy', 'vs rok wcześniej')) : ''}</div>
        </div>`).join('')
        + offerTilesHtml()
        + (_kpi.prev ? '' : `<div class="kpi-note">${escHtml(L('kpi_no_compare', 'Porównanie wymaga zakresu „od–do”.'))}</div>`)
        + (c.itemsWithoutClientPrice ? `<div class="kpi-note">${escHtml(L('kpi_no_client_price', '{n} pozycji bez ceny klienta (zapisane przed cenami klienta) — w sprzedaży liczone jako 0.', { n: fmtInt(c.itemsWithoutClientPrice) }))}</div>` : '');
    bar.hidden = false;
}

// Kafelki ofert — tylko gdy baza ma znacznik oferty (serwer zwraca wtedy `offers`).
function offerTilesHtml() {
    if (!_offers) return '';
    const o = _offers;
    const tile = (label, value, sub) => `
        <div class="kpi-tile kpi-tile-offer">
            <div class="kpi-label">${escHtml(label)}</div>
            <div class="kpi-value">${value}</div>
            <div class="kpi-sub">${escHtml(sub)}</div>
        </div>`;
    return tile(L('kpi_offers_open', 'Otwarte oferty'), fmtInt(o.open.count), `${fmt(o.open.value)} ${_cur}`)
        + tile(L('kpi_offers_conversion', 'Konwersja ofert'), pct(o.rate),
            L('offers_sent_of', '{sent} z {total} · {value}', { sent: fmtInt(o.sent.count), total: fmtInt(o.total.count), value: `${fmt(o.sent.value)} ${_cur}` }));
}

function renderOffers() {
    const o = _offers;
    const days = o?.staleDays || 14;
    const intro = `<p class="report-intro">${escHtml(L('offers_intro', 'Oferta = niewysłane zlecenie, z którego zrobiono PDF albo które przyszło importem na konto bez automatycznej wysyłki. Zakres dat liczony od dnia oferty.'))}</p>`;
    if (!o) { showArea(intro + `<div class="reports-empty">${escHtml(L('no_data', 'Brak danych.'))}</div>`); return; }
    const line = (label, x) => `<tr><td>${escHtml(label)}</td><td class="num">${fmtInt(x.count)}</td><td class="num">${fmt(x.value)}</td></tr>`;
    const summary = tableHtml([{ label: L('cat_offers', 'Oferty') }, { label: L('col_count', 'Liczba'), num: true }, { label: valueLabel(), num: true }], [
        line(L('offers_total', 'Oferty z okresu'), o.total),
        line(L('offers_sent', 'Wysłane jako zlecenie'), o.sent),
        line(L('offers_open', 'Otwarte'), o.open),
        line(L('offers_stale', 'w tym bez ruchu dłużej niż {days} dni', { days }), o.staleTotal),
    ]);
    const title = `<h3 class="report-subtitle">${escHtml(L('offers_stale_title', 'Otwarte oferty bez ruchu dłużej niż {days} dni', { days }))}</h3>`;
    if (!o.stale.length) {
        showArea(intro + summary + title + `<div class="reports-empty">${escHtml(L('offers_stale_empty', 'Brak ofert bez ruchu.'))}</div>`);
        return;
    }
    const head = [
        { label: L('col_client', 'Klient') }, { label: L('col_order', 'Zlecenie') },
        { label: L('col_offer_date', 'Data oferty'), num: true }, { label: L('col_offer_days', 'Dni bez ruchu'), num: true },
        { label: valueLabel(), num: true },
    ];
    const rows = o.stale.map(s => {
        const label = `${escHtml(`${s.id}/${s.order_idx ?? ''}`)}${s.commision ? ` — ${escHtml(s.commision)}` : ''}`;
        // Odnośnik tylko dla ownera (serwer nie daje `href` w podglądzie admina).
        const order = s.href ? `<a href="${escHtml(s.href)}">${label}</a>` : label;
        return `<tr>${clientCell(s.ident, s.client_name)}<td>${order}</td><td class="num">${escHtml(s.offer_day)}</td>
            <td class="num">${fmtInt(s.days)}</td><td class="num">${fmt(s.value)}</td></tr>`;
    });
    showArea(intro + summary + title + tableHtml(head, rows));
}

function tableHtml(head, rows) {
    return `<div class="report-table-wrap"><table class="report-table">
        <thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${escHtml(h.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>`;
}

function clientCell(ident, name) {
    return `<td><div style="font-weight:600;">${escHtml(ident)}</div><div style="font-size:0.75rem;color:var(--text-muted,#6c757d);">${escHtml(name || '')}</div></td>`;
}

function renderWinback() {
    const intro = `<p class="report-intro">${escHtml(L('winback_intro', 'Klienci z co najmniej 3 zleceniami w ostatnich 12 miesiącach, którzy nie zamawiają dłużej niż dwukrotność swojego typowego odstępu (min. 45 dni). Niezależne od zakresu dat.'))}</p>`;
    if (!_winback.length) {
        showArea(intro + `<div class="reports-empty">${escHtml(L('winback_empty', 'Brak klientów do odzyskania.'))}</div>`);
        return;
    }
    const head = [
        { label: '#' }, { label: L('col_client', 'Klient') },
        { label: L('col_last_order', 'Ostatnie zlecenie') }, { label: L('col_days_since', 'Dni od zlecenia'), num: true },
        { label: L('col_typical_gap', 'Typowy odstęp (dni)'), num: true }, { label: L('col_orders_12m', 'Zlecenia (12 mies.)'), num: true },
        { label: L('col_turnover_12m', 'Obrót 12 mies. ({cur})', { cur: _cur }), num: true },
    ];
    const rows = _winback.map((w, i) => `<tr><td><span class="rank-badge">${i + 1}</span></td>${clientCell(w.ident, w.client_name)}
        <td>${escHtml(w.last_order)}</td><td class="num">${fmtInt(w.days_since)}</td><td class="num">${fmtInt(w.typical_gap)}</td>
        <td class="num">${fmtInt(w.orders)}</td><td class="num">${fmt(w.value)}</td></tr>`);
    showArea(intro + tableHtml(head, rows));
}

function renderAbc(kind) {
    const items = (_abc && _abc[kind]) || [];
    const intro = `<p class="report-intro">${escHtml(L('abc_intro', 'A = pozycje dające 80% sprzedaży, B = kolejne 15%, C = reszta.'))}</p>`;
    if (!items.length) {
        showArea(intro + `<div class="reports-empty">${escHtml(L('no_data', 'Brak danych.'))}</div>`);
        return;
    }
    destroyChart();
    const counts = { A: 0, B: 0, C: 0 };
    items.forEach(i => { counts[i.cls]++; });
    const summary = `<div class="abc-summary">${['A', 'B', 'C'].map(c => `<span class="abc-badge abc-${c}">${c}</span> ${fmtInt(counts[c])}`).join(' &nbsp; ')}</div>`;
    const head = [
        { label: '#' }, { label: kind === 'clients' ? L('col_client', 'Klient') : L('col_group', 'Grupa') },
        { label: valueLabel(), num: true }, { label: L('col_share', 'Udział'), num: true },
        { label: L('col_cumulative', 'Skumulowany'), num: true }, { label: L('col_class', 'Klasa') },
    ];
    const rows = items.map((i, idx) => `<tr><td><span class="rank-badge">${idx + 1}</span></td>
        ${kind === 'clients' ? clientCell(i.label, i.name) : `<td><div style="font-weight:600;">${escHtml(i.label)}</div><div style="font-size:0.75rem;color:var(--text-muted,#6c757d);">${escHtml(i.dept || '')}</div></td>`}
        <td class="num">${fmt(i.value)}</td><td class="num">${pct(i.share)}</td><td class="num">${pct(i.cumulative)}</td>
        <td><span class="abc-badge abc-${i.cls}">${i.cls}</span></td></tr>`);
    showArea(intro + summary + `<div class="chart-container abc-chart"><canvas id="report-chart" role="img" aria-label="${escHtml(L('abc_chart_label', 'Skumulowany udział w sprzedaży'))}"></canvas></div>` + tableHtml(head, rows));

    // Jedna linia: skumulowany udział (jedna oś, %), progi 80% i 95% jako przerywane linie odniesienia.
    const labels = items.map(i => i.label);
    const guide = (v) => ({ label: `${v}%`, data: labels.map(() => v), borderColor: 'rgba(108,117,125,0.6)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, pointHitRadius: 0, guide: true });
    _chartInstance = new Chart(document.getElementById('report-chart').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: L('abc_chart_label', 'Skumulowany udział w sprzedaży'), data: items.map(i => +(i.cumulative * 100).toFixed(2)), borderColor: 'rgba(13,110,253,1)', backgroundColor: 'rgba(13,110,253,1)', borderWidth: 2, pointRadius: items.length > 60 ? 0 : 3, pointHoverRadius: 5, tension: 0 },
                guide(80), guide(95),
            ],
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    filter: c => !c.dataset.guide,
                    callbacks: {
                        label: c => `${pct(items[c.dataIndex].cumulative)} · ${L('col_class', 'Klasa')} ${items[c.dataIndex].cls}`,
                        afterLabel: c => `${fmt(items[c.dataIndex].value)} ${_cur}`,
                    },
                },
            },
            scales: {
                x: { ticks: { maxRotation: 45, font: { size: 11 }, autoSkip: true } },
                y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, title: { display: true, text: L('col_cumulative', 'Skumulowany') } },
            },
        },
    });
}

// Sezonowość: miesiące × lata, kolor jednej barwy od jasnego do ciemnego (im więcej, tym ciemniej).
function renderSeasonality() {
    const byValue = _activeMetrics.value;
    const key = byValue ? 'total_value' : 'order_count';
    const cells = new Map(_seasonality.map(r => [r.month, Number(r[key]) || 0]));
    const years = [...new Set(_seasonality.map(r => r.month.slice(0, 4)))].sort();
    const intro = `<p class="report-intro">${escHtml(L('seasonality_intro', 'Cała historia zleceń wybranych klientów, niezależnie od zakresu dat.'))} ${escHtml(byValue ? valueLabel() : L('metric_orders', 'Zlecenia'))}</p>`;
    if (!years.length) { showArea(intro + `<div class="reports-empty">${escHtml(L('no_data', 'Brak danych.'))}</div>`); return; }
    const max = Math.max(...cells.values(), 1);
    const monthName = (m) => new Date(2000, m - 1, 1).toLocaleDateString(NUM_LOCALE, { month: 'long' });
    const show = (v) => (byValue ? fmt(v) : fmtInt(v));
    const cell = (v) => {
        const a = v ? 0.08 + 0.82 * (v / max) : 0;
        return `<td class="num season-cell" style="background:rgba(13,110,253,${a.toFixed(2)});${a > 0.5 ? 'color:#fff;' : ''}">${v ? show(v) : '—'}</td>`;
    };
    const head = [{ label: L('col_month', 'Miesiąc') }, ...years.map(y => ({ label: y, num: true }))];
    const rows = [];
    for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0');
        rows.push(`<tr><td>${escHtml(monthName(m))}</td>${years.map(y => cell(cells.get(`${y}-${mm}`) || 0)).join('')}</tr>`);
    }
    const yearTotal = (y) => [...cells.entries()].filter(([k]) => k.startsWith(y)).reduce((s, [, v]) => s + v, 0);
    rows.push(`<tr class="season-total"><td><strong>${escHtml(L('col_total', 'Razem'))}</strong></td>${years.map(y => `<td class="num"><strong>${show(yearTotal(y))}</strong></td>`).join('')}</tr>`);
    showArea(intro + tableHtml(head, rows));
}

// Eksport aktywnego widoku: tabele z ekranu (wszystkie sekcje), a w widoku wykresu — dane wykresu.
function parseLocaleNumber(text) {
    const parts = new Intl.NumberFormat(NUM_LOCALE).formatToParts(12345.6);
    const group = parts.find(p => p.type === 'group')?.value || '';
    const dec = parts.find(p => p.type === 'decimal')?.value || '.';
    const t = text.replace(/ | /g, ' ').trim();
    if (!/^-?[\d\s.,']+$/.test(t)) return text;
    const n = Number(t.split(group).join('').replace(/\s/g, '').replace(dec, '.'));
    return Number.isFinite(n) ? n : text;
}

function exportRows() {
    const area = document.getElementById('report-area');
    const tables = [...area.querySelectorAll('table.report-table')];
    const rows = [];
    const headerRows = [];
    if (tables.length) {
        tables.forEach(table => {
            const title = table.closest('.dept-section')?.querySelector('.dept-name')?.textContent;
            if (title) rows.push([title]);
            headerRows.push(rows.length);
            rows.push([...table.querySelectorAll('thead th')].map(th => th.textContent.trim()));
            table.querySelectorAll('tbody tr').forEach(tr => {
                rows.push([...tr.cells].map(td => parseLocaleNumber((td.innerText || td.textContent).trim().replace(/\s*\n\s*/g, ' — '))));
            });
        });
    } else if (_chartInstance) {
        const sets = _chartInstance.data.datasets.filter(d => !d.guide);
        headerRows.push(0);
        rows.push(['', ...sets.map(d => d.label)]);
        _chartInstance.data.labels.forEach((label, i) => rows.push([label, ...sets.map(d => Number(d.data[i]) || 0)]));
    }
    return { rows, headerRows };
}

async function exportXlsx() {
    const { rows, headerRows } = exportRows();
    if (!rows.length) return;
    const { ExcelJSGenerator } = await import('/scripts/components/generators_exceljs.js');
    const { dateFrom, dateTo } = currentRange();
    const view = document.querySelector('#view-toggle button.active')?.textContent.trim() || '';
    const title = `${L('title', 'Raporty')} — ${view} (${dateFrom || '…'} → ${dateTo || '…'}, ${_cur})`;
    await new ExcelJSGenerator().generateFromRows({ title, rows, headerRows, fileName: `${L('title', 'Raporty')}_${view}_${dateTo || todayStr()}` });
}

function initOrgTools() {
    document.getElementById('btn-export-xlsx')?.addEventListener('click', () => exportXlsx().catch(err => console.error('XLSX export failed', err)));
    document.getElementById('btn-print')?.addEventListener('click', () => window.print());
    document.getElementById('report-currency')?.addEventListener('change', runReport);
    // Kłódka: ta sama flaga sesji co w podglądzie zlecenia; serwer i tak liczy zakup tylko po otwarciu.
    document.getElementById('btn-toggle-purchase')?.addEventListener('click', async () => {
        const res = await fetch('/orders/toggle-sub', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
        if (res.ok) window.location.reload();
    });
}

// ── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initClientList();
    initViewToggle();
    initMetricToggles();
    initCollapsible();
    initConfigControls();

    initDateControls();

    document.getElementById('btn-run-report').addEventListener('click', runReport);
    if (ORG) initOrgTools();

    // Default date range: last 12 months
    const now = new Date();
    document.getElementById('date-to').value = todayStr();
    const past = new Date(now);
    past.setFullYear(past.getFullYear() - 1);
    document.getElementById('date-from').value =
        `${past.getFullYear()}-${String(past.getMonth()+1).padStart(2,'0')}-${String(past.getDate()).padStart(2,'0')}`;

    // Auto-run on load
    runReport();
});
