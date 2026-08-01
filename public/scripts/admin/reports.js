// ── Reports module frontend ───────────────────────────────────────
// Categories: overall | groups
// Overall sub-views: table | bar | trend
// Groups sub-views:  groups-table | groups-chart

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

// ── Helpers ───────────────────────────────────────────────────────

function fmt(n) {
    return Number(n).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n) {
    return Number(n).toLocaleString('pl-PL');
}

async function parseJsonResponse(res) {
    const contentType = res.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
        const body = await res.text();
        if (res.status === 401 || res.status === 403) {
            throw new Error('Brak dostępu do raportów albo sesja wygasła.');
        }
        if (body && body.trim().startsWith('<')) {
            throw new Error('Endpoint raportów zwrócił HTML zamiast JSON. Sprawdź backend lub sesję użytkownika.');
        }
        throw new Error(`Nieprawidłowa odpowiedź serwera (${res.status}).`);
    }

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.message || `Błąd serwera (${res.status}).`);
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
        updateSelectionInfo();
    });

    document.getElementById('btn-deselect-all').addEventListener('click', () => {
        document.querySelectorAll('#client-list .client-list-item').forEach(item => {
            item.classList.remove('selected');
            item.querySelector('input[type="checkbox"]').checked = false;
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
        ? 'Bez ograniczenia — cała historia zamówień.'
        : `Wszystkie widoki: ${dateFrom || 'początek'} → ${dateTo || 'dziś'}`;
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

    try {
        const res = await fetch('/admin/api/reports/stats', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds, dateFrom, dateTo }),
        });
        const data = await parseJsonResponse(res);
        if (runId !== _runSeq) return; // a newer range was requested meanwhile
        if (!data.success) throw new Error(data.message);

        _currentStats  = Array.isArray(data.stats)        ? data.stats        : [];
        _currentTrend  = Array.isArray(data.trend)        ? data.trend        : [];
        _currentGroups = Array.isArray(data.groups)       ? data.groups       : [];
        _currentDeptClients = Array.isArray(data.deptClients) ? data.deptClients : [];
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
        showArea('<div class="reports-loading"><div class="spinner-border spinner-border-sm text-secondary"></div> Ładowanie danych...</div>');
        document.getElementById('summary-bar').style.display = 'none';
    }
}

function updateReportMeta(dateFrom, dateTo, clientCount) {
    let meta = `${clientCount} klientów`;
    if (dateFrom || dateTo) meta += ` · ${dateFrom || '…'} → ${dateTo || '…'}`;
    document.getElementById('report-meta').textContent = meta;
}

function updateSummary() {
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
}

// ── Table view ────────────────────────────────────────────────────

const COLS = [
    { key: 'rank',           label: '#',             numeric: false, sortable: false },
    { key: 'ident',          label: 'Klient',        numeric: false },
    { key: 'order_count',    label: 'Zamówienia',    numeric: true,  metric: 'orders'    },
    { key: 'total_value',    label: 'Wartość (€)',   numeric: true,  metric: 'value'     },
    { key: 'position_count', label: 'Pozycje',       numeric: true,  metric: 'positions' },
];

function sortedStats() {
    const data = [..._currentStats];
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
        showArea('<div class="reports-empty">Brak danych dla wybranych filtrów.</div>');
        return;
    }

    const rows = sortedStats();
    const cols = COLS.filter(c => !c.metric || _activeMetrics[c.metric]);

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
    return Object.entries(map).sort((a, b) => a[1].localeCompare(b[1], 'pl'));
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
            <button class="btn btn-xs btn-outline-secondary btn-sm py-0" id="gf-select-all-depts">Wszystkie</button>
            <button class="btn btn-xs btn-outline-secondary btn-sm py-0" id="gf-deselect-all-depts">Odznacz</button>
        </div>
        ${deptCheckboxes}
    </div>`;

    return `<div class="groups-filter-bar" id="groups-filter-bar">
        <div class="gf-mode-toggle">
            <button class="${_groupsMode === 'depts' ? 'active' : ''}" data-gmode="depts">
                <i class="bi bi-building me-1"></i>Całe działy
            </button>
            <button class="${_groupsMode === 'groups' ? 'active' : ''}" data-gmode="groups">
                <i class="bi bi-grid-3x3-gap me-1"></i>Konkretne grupy
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
        showArea('<div class="reports-empty">Brak danych grup dla wybranych filtrów.</div>');
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

        const colHeaders = [{ label: 'Dział', num: false }];
        if (showPos)    colHeaders.push({ label: 'Pozycje',    num: true });
        if (showOrders) colHeaders.push({ label: 'Zamówienia', num: true });
        if (showValue)  colHeaders.push({ label: 'Wartość (€)', num: true });

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

        const colHeaders = [{ label: 'Grupa', num: false }];
        if (showPos)    colHeaders.push({ label: 'Pozycje',    num: true });
        if (showOrders) colHeaders.push({ label: 'Zamówienia', num: true });
        if (showValue)  colHeaders.push({ label: 'Wartość (€)', num: true });

        Object.values(byDept).forEach(dept => {
            const deptPos = showPos    ? `<span class="dept-stat">${fmtInt(dept.totPos)} poz.</span>` : '';
            const deptOrd = showOrders ? `<span class="dept-stat">${fmtInt(dept.totOrd)} zam.</span>` : '';
            const deptVal = showValue  ? `<span class="dept-stat">${fmt(dept.totVal)} €</span>` : '';

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
        showArea('<div class="reports-empty">Brak danych grup dla wybranych filtrów.</div>');
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
    if (hasValue)  datasets.push({ label: 'Wartość (€)', data: vals, backgroundColor: 'rgba(13,110,253,0.7)',  borderRadius: 4, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: 'Zamówienia',  data: ords, backgroundColor: 'rgba(25,135,84,0.7)',   borderRadius: 4, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: 'Pozycje',     data: pos,  backgroundColor: 'rgba(255,193,7,0.7)',   borderRadius: 4, yAxisID: countAxis });

    const scales = {
        x: { ticks: { maxRotation: 45, font: { size: 11 } } },
        y: { position: 'left', title: { display: true, text: hasValue ? 'Wartość (€)' : 'Ilość' } }
    };
    if ((hasOrders || hasPos) && hasValue) {
        scales.y2 = { position: 'right', title: { display: true, text: 'Ilość' }, grid: { drawOnChartArea: false } };
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
                        label: c => c.dataset.label + ': ' + (c.dataset.label === 'Wartość (€)' ? fmt(c.parsed.y) + ' €' : fmtInt(c.parsed.y)),
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
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
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
        showArea('<div class="reports-empty">Brak danych dla wybranych filtrów.</div>');
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
        showArea(deptBar + '<div class="reports-empty">Brak klientów w tym dziale.</div>');
        initDeptClientDeptBar();
        return;
    }

    const colHeaders = [{ label: '#', num: false }, { label: 'Klient', num: false }];
    if (showPos)    colHeaders.push({ label: 'Pozycje',     num: true });
    if (showOrders) colHeaders.push({ label: 'Zamówienia',  num: true });
    if (showValue)  colHeaders.push({ label: 'Wartość (€)', num: true });

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
        showArea('<div class="reports-empty">Brak danych dla wybranych filtrów.</div>');
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
    if (hasValue)  datasets.push({ label: 'Wartość (€)', data: vals, backgroundColor: 'rgba(13,110,253,0.7)',  borderRadius: 4, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: 'Zamówienia',  data: ords, backgroundColor: 'rgba(25,135,84,0.7)',   borderRadius: 4, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: 'Pozycje',     data: pos,  backgroundColor: 'rgba(255,193,7,0.7)',   borderRadius: 4, yAxisID: countAxis });

    const scales = {
        x: { ticks: { maxRotation: 45, font: { size: 11 } } },
        y: { position: 'left', title: { display: true, text: hasValue ? 'Wartość (€)' : 'Ilość' } }
    };
    if ((hasOrders || hasPos) && hasValue) {
        scales.y2 = { position: 'right', title: { display: true, text: 'Ilość' }, grid: { drawOnChartArea: false } };
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
                        label: c => c.dataset.label + ': ' + (c.dataset.label === 'Wartość (€)' ? fmt(c.parsed.y) + ' €' : fmtInt(c.parsed.y)),
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
        showArea('<div class="reports-empty">Brak danych.</div>');
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
    if (hasValue)  datasets.push({ label: 'Wartość (€)', data: top.map(r => Number(r.total_value)),    backgroundColor: 'rgba(13,110,253,0.7)', borderRadius: 4, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: 'Zamówienia',  data: top.map(r => Number(r.order_count)),    backgroundColor: 'rgba(25,135,84,0.7)',  borderRadius: 4, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: 'Pozycje',     data: top.map(r => Number(r.position_count)), backgroundColor: 'rgba(255,193,7,0.7)',  borderRadius: 4, yAxisID: countAxis });

    const scales = { x: { ticks: { maxRotation: 45, font: { size: 11 } } }, y: { position: 'left', title: { display: true, text: hasValue ? 'Wartość (€)' : 'Ilość' } } };
    if ((hasOrders || hasPos) && hasValue) scales.y2 = { position: 'right', title: { display: true, text: 'Ilość' }, grid: { drawOnChartArea: false } };

    _chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels: top.map(r => r.ident), datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: { callbacks: { label: c => c.dataset.label + ': ' + (c.dataset.label === 'Wartość (€)' ? fmt(c.parsed.y) + ' €' : fmtInt(c.parsed.y)) } }
            },
            scales,
        }
    });
}

// ── Trend chart ───────────────────────────────────────────────────

function renderTrendChart() {
    if (!_currentTrend.length) {
        showArea('<div class="reports-empty">Brak danych trendu.</div>');
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
    if (hasValue)  datasets.push({ label: 'Wartość (€)', data: _currentTrend.map(r => Number(r.total_value)),    borderColor: 'rgba(13,110,253,1)', backgroundColor: 'rgba(13,110,253,0.1)', fill: true,  tension: 0.3, yAxisID: 'y' });
    if (hasOrders) datasets.push({ label: 'Zamówienia',  data: _currentTrend.map(r => Number(r.order_count)),    borderColor: 'rgba(25,135,84,1)',  backgroundColor: 'rgba(25,135,84,0.08)', fill: false, tension: 0.3, yAxisID: countAxis });
    if (hasPos)    datasets.push({ label: 'Pozycje',     data: _currentTrend.map(r => Number(r.position_count)), borderColor: 'rgba(255,193,7,1)',  backgroundColor: 'rgba(255,193,7,0.08)', fill: false, tension: 0.3, yAxisID: countAxis });

    const scales = { y: { position: 'left', title: { display: true, text: hasValue ? 'Wartość (€)' : 'Ilość' } } };
    if ((hasOrders || hasPos) && hasValue) scales.y2 = { position: 'right', title: { display: true, text: 'Ilość' }, grid: { drawOnChartArea: false } };

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
        if (!name) { alert('Wpisz nazwę konfiguracji.'); return; }
        const ids = getSelectedIds();
        const { dateFrom, dateTo } = currentRange();
        const dateToToday = document.getElementById('date-to-today').checked;

        const res = await fetch('/admin/api/reports/configs', {
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
            if (!confirm(`Usunąć konfigurację „${name}"?`)) return;
            const res = await fetch('/admin/api/reports/configs/' + encodeURIComponent(name), {
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
        const clientsLabel = cfg.userIds?.length ? cfg.userIds.length + ' klientów' : 'wszyscy';
        const dateLabel = cfg.dateFrom
            ? `${cfg.dateFrom} → ${cfg.dateToToday ? 'dzisiaj' : (cfg.dateTo || '…')}`
            : (cfg.dateToToday ? '→ dzisiaj' : '');
        item.innerHTML = `
            <div>
                <div class="config-name">${escHtml(cfg.name)}</div>
                <div class="config-meta">${clientsLabel}${dateLabel ? ' · ' + dateLabel : ''}</div>
            </div>
            <button class="config-delete-btn" data-name="${escHtml(cfg.name)}" title="Usuń">×</button>`;
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

        if (_currentStats.length || _currentGroups.length) renderActiveView();
    });

    // Sub-view (second level)
    document.getElementById('view-toggle').addEventListener('click', e => {
        const btn = e.target.closest('button[data-view]');
        if (!btn || btn.style.display === 'none') return;
        document.querySelectorAll('#view-toggle button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _activeView = btn.dataset.view;
        if (_currentStats.length || _currentGroups.length) renderActiveView();
    });
}

// ── Utils ─────────────────────────────────────────────────────────

function showArea(html) {
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
        if (_currentStats.length || _currentTrend.length) renderActiveView();
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

// ── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initClientList();
    initViewToggle();
    initMetricToggles();
    initCollapsible();
    initConfigControls();

    initDateControls();

    document.getElementById('btn-run-report').addEventListener('click', runReport);

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
