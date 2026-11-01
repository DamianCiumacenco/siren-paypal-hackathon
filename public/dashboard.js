// Siren dashboard (milestone 15). Read-only view of ONE group, opened from the link
// `/siren dashboard` DMs you. The signed token is in the URL fragment (#t=…): browsers
// never send fragments to the server, so it stays out of request logs. We move it to
// sessionStorage (reloads keep working) and clear it from the address bar.
// Everything from the API is rendered as text (textContent / AG Grid's escaping), never HTML.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'siren-dashboard-token';

  function readToken() {
    const m = /(?:^#|&)t=([^&]+)/.exec(location.hash);
    if (m) {
      try { sessionStorage.setItem(STORAGE_KEY, m[1]); } catch (_) { /* private mode: fine */ }
      history.replaceState(null, '', location.pathname);
      return m[1];
    }
    try { return sessionStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  }

  function notice(text, isError) {
    const el = $('notice');
    el.textContent = text;
    el.classList.toggle('error', Boolean(isError));
    el.hidden = false;
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function reliabilityBar(p) {
    const v = p.value;
    if (v === null || v === undefined) return el('span', 'hint', 'no history yet');
    const wrap = el('div', 'bar');
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
    fill.style.background = v > 0.8 ? 'var(--good)' : v >= 0.4 ? 'var(--warn)' : 'var(--bad)';
    track.appendChild(fill);
    wrap.append(track, el('span', 'bar-num', v.toFixed(2)));
    return wrap;
  }

  function pill(value, extra) {
    const span = el('span', `pill ${value}`, value);
    if (!extra) return span;
    const wrap = el('span');
    wrap.append(span, el('span', 'hint', ` ${extra}`));
    return wrap;
  }

  function grid(container, options) {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    container.classList.add(dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz');
    return agGrid.createGrid(container, {
      domLayout: 'autoHeight',
      defaultColDef: { sortable: true, filter: true, resizable: true, minWidth: 90, flex: 1 },
      overlayNoRowsTemplate: '<span>Nothing here yet.</span>',
      ...options,
    });
  }

  function render(data) {
    $('title').textContent = data.group.title;
    $('meta').textContent = `Updated ${fmtDate(data.generatedAt)} · link valid until ${fmtDate(data.expiresAt)}`;

    const open = data.splits.filter((s) => s.status === 'open').length;
    $('stat-open').textContent = String(open);
    $('stat-owed').textContent = String(data.members.filter((m) => m.owes).length);
    $('stat-decisions').textContent = String(data.reasoning.length);
    $('stats').hidden = false;

    grid($('members'), {
      rowData: data.members,
      columnDefs: [
        { field: 'name', headerName: 'Member', minWidth: 110 },
        { field: 'reliability', headerName: 'Reliability', cellRenderer: reliabilityBar, minWidth: 160, sort: 'desc' },
        { field: 'tone', headerName: 'Reminder tone', cellRenderer: (p) => pill(p.value, p.data.toneSource), minWidth: 150 },
        { field: 'avgHoursToPay', headerName: 'Avg time to pay', valueFormatter: (p) => (p.value == null ? '' : `${Math.round(p.value)}h`) },
        { field: 'onTime', headerName: 'Paid on time' },
        { field: 'owes', headerName: 'Owes now' },
      ],
    });
    $('members-card').hidden = false;

    grid($('splits'), {
      rowData: data.splits,
      columnDefs: [
        { field: 'description', headerName: 'Split', minWidth: 120 },
        { field: 'status', cellRenderer: (p) => pill(p.value), maxWidth: 130 },
        { field: 'each', headerName: 'Each' },
        { field: 'total' },
        { field: 'paid', headerName: 'Paid' },
        { field: 'owing', headerName: 'Still owing', minWidth: 140 },
        { field: 'paidBy', headerName: 'Paid the bill' },
        { field: 'created', valueFormatter: (p) => fmtDate(p.value), sort: 'desc', minWidth: 130 },
      ],
    });
    $('splits-card').hidden = false;

    const detail = $('detail');
    grid($('reasoning'), {
      rowData: data.reasoning,
      pagination: true,
      paginationPageSize: 10,
      paginationPageSizeSelector: false,
      rowSelection: 'single',
      onSelectionChanged: (e) => {
        const row = e.api.getSelectedRows()[0];
        detail.hidden = !row;
        if (row) detail.textContent = `${fmtDate(row.at)} · ${row.trigger}\n\n${row.detail || '(no steps recorded)'}\n\nReply: ${row.summary || '(none)'}`;
      },
      columnDefs: [
        { field: 'at', headerName: 'When', valueFormatter: (p) => fmtDate(p.value), sort: 'desc', minWidth: 130 },
        { field: 'trigger', headerName: 'Why it ran', minWidth: 190 },
        { field: 'tools', headerName: 'Tools used', minWidth: 160 },
        { field: 'summary', headerName: 'What it said', minWidth: 220, flex: 2, tooltipField: 'summary' },
        { field: 'models', headerName: 'Model', minWidth: 140 },
      ],
    });
    $('reasoning-card').hidden = false;
  }

  async function main() {
    const token = readToken();
    if (!token) {
      notice('Open this page from the link Siren sends you: type /siren dashboard in your group.', true);
      return;
    }
    notice('Loading…');
    let res;
    try {
      res = await fetch('/dashboard/api', { headers: { 'x-dashboard-token': token }, cache: 'no-store' });
    } catch (_) {
      notice('Could not reach Siren. Check your connection and reload.', true);
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 403) { try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {} }
      notice(body.error || `Could not load the dashboard (HTTP ${res.status}).`, true);
      return;
    }
    $('notice').hidden = true;
    render(body);
  }

  main();
})();
