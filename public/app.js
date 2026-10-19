/* WorkshopRelay Console — single-page app (same-origin /api, no dependencies). */
'use strict';

/* ============================== state ============================== */
const state = {
  personas: [],
  identity: null, // { label, role, memberId, token }
  tab: 'workshops',
  workshopFilter: '',
  workshopSearch: '',
  workshops: [],
  notifFilter: { status: '', type: '', search: '' },
  notifications: null,
  mockStats: null,
  mockFaults: null,
  receipts: null,
  system: null,
  pollTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ============================== api ============================== */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.identity?.token) headers.authorization = `Bearer ${state.identity.token}`;
  if (opts.body !== undefined && !(opts.body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code || 'HTTP_ERROR';
    err.details = data?.error?.details;
    err.requestId = data?.error?.requestId;
    throw err;
  }
  return data;
}

/* ============================== toasts ============================== */
function toast(kind, title, body = '', ms = 4200) {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title"></div><div class="t-body"></div>`;
  $('.t-title', el).textContent = title;
  $('.t-body', el).textContent = body;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

function toastError(err, prefix = 'Request failed') {
  const extra = err.requestId ? ` (requestId ${err.requestId.slice(0, 8)}…)` : '';
  toast('error', prefix, `${err.message}${extra}`);
}

/* ============================== modal ============================== */
function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalBackdrop').hidden = false;
}
function closeModal() { $('#modalBackdrop').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modalClose').addEventListener('click', closeModal);
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmModal(title, message, confirmLabel, onConfirm) {
  openModal(title, `
    <p style="color:var(--text-dim);margin:0 0 18px">${message}</p>
    <div class="btn-row" style="justify-content:flex-end">
      <button class="btn btn-ghost" id="confirmCancel">Cancel</button>
      <button class="btn btn-danger" id="confirmOk">${confirmLabel}</button>
    </div>`);
  $('#confirmCancel').onclick = closeModal;
  $('#confirmOk').onclick = async () => {
    $('#confirmOk').disabled = true;
    try { await onConfirm(); closeModal(); } catch (err) { toastError(err); $('#confirmOk').disabled = false; }
  };
}

/* ============================== formatting ============================== */
function fmtUtc(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
function fmtLocal(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtRelative(iso) {
  if (!iso) return '–';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rel = diff > 0 ? 'in ' : '';
  const suffix = diff > 0 ? '' : ' ago';
  if (abs < 1000) return 'now';
  if (abs < 60_000) return `${rel}${Math.round(abs / 1000)}s${suffix}`;
  if (abs < 3_600_000) return `${rel}${Math.round(abs / 60_000)}m${suffix}`;
  return `${rel}${Math.round(abs / 3_600_000)}h${suffix}`;
}
function statusPill(status) {
  return `<span class="status-pill s-${String(status).toLowerCase()}">${status}</span>`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortId(id) { return String(id || '').slice(0, 8); }

/* ============================== personas ============================== */
function initial(label) { return (label || '?').trim().charAt(0).toUpperCase(); }

function renderPersona() {
  const id = state.identity;
  $('#personaAvatar').textContent = id ? initial(id.label) : '?';
  $('#personaName').textContent = id ? id.label : 'Sign in';
  $('#personaRole').textContent = id ? id.role.toLowerCase() : 'choose a demo identity';

  const menu = $('#personaMenu');
  menu.innerHTML = state.personas.map((p, i) => `
    <button class="persona-option" data-idx="${i}">
      <span class="avatar">${initial(p.label)}</span>
      <span class="persona-meta">
        <span class="persona-name">${esc(p.label)}</span>
        <span class="persona-role">${p.memberId ? 'member' : 'organizer'}</span>
      </span>
      <span class="role-chip ${p.role.toLowerCase()}">${p.role.toLowerCase()}</span>
    </button>`).join('') + `
    <button class="persona-option" data-signout="1">
      <span class="avatar">⎋</span>
      <span class="persona-meta"><span class="persona-name">Sign out</span>
      <span class="persona-role">clear local token</span></span>
    </button>`;
  $$('.persona-option', menu).forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.signout) {
        state.identity = null;
        localStorage.removeItem('wr-token');
      } else {
        const p = state.personas[Number(btn.dataset.idx)];
        setIdentity(p);
      }
      menu.hidden = true;
      renderPersona();
      renderGate();
      refreshAll();
    });
  });
}

function setIdentity(p) {
  state.identity = p;
  localStorage.setItem('wr-token', p.token);
}

function renderGate() {
  const gate = $('#gate');
  const hasIdentity = Boolean(state.identity);
  gate.hidden = hasIdentity;
  $$('.tab-panel').forEach((el) => { el.hidden = !hasIdentity || el.id !== `tab-${state.tab}`; });

  const box = $('#gatePersonas');
  box.innerHTML = state.personas.map((p, i) => `
    <button class="gate-persona" data-idx="${i}">
      <span class="avatar">${initial(p.label)}</span>
      <strong>${esc(p.label)}</strong>
      <span class="role-chip ${p.role.toLowerCase()}">${p.role.toLowerCase()}</span>
    </button>`).join('');
  $$('.gate-persona', box).forEach((btn) => {
    btn.addEventListener('click', () => {
      setIdentity(state.personas[Number(btn.dataset.idx)]);
      renderPersona();
      renderGate();
      refreshAll();
    });
  });
}

$('#personaBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#personaMenu');
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', () => { $('#personaMenu').hidden = true; });

$('#manualTokenBtn').addEventListener('click', async () => {
  const token = $('#manualToken').value.trim();
  if (!token) return;
  const prev = state.identity;
  state.identity = { label: 'Custom', role: 'UNKNOWN', token, memberId: null };
  try {
    const me = await api('/api/demo/whoami');
    setIdentity({ label: me.label, role: me.role, memberId: me.memberId, token });
    toast('success', 'Signed in', `Authenticated as ${me.label}`);
    renderPersona(); renderGate(); refreshAll();
  } catch (err) {
    state.identity = prev;
    toastError(err, 'Token rejected');
  }
});

/* ============================== navigation ============================== */
function switchTab(tab) {
  state.tab = tab;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  $$('.tab-panel').forEach((el) => { el.hidden = el.id !== `tab-${tab}`; });
  $('#sidebar').classList.remove('open');
  refreshAll();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => switchTab(n.dataset.tab)));
$('#sidebarToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

/* ============================== health ============================== */
async function refreshHealth() {
  try {
    const s = await api('/api/system/status');
    state.system = s;
    const set = (id, ok) => {
      const el = $(id);
      el.classList.toggle('pill-ok', ok);
      el.classList.toggle('pill-bad', !ok);
      el.classList.toggle('pill-unknown', false);
    };
    set('#pillDb', s.database === 'up');
    set('#pillMock', s.mock.reachable);
    const liveWorker = (s.workers || []).find((w) => w.live);
    set('#pillWorker', Boolean(liveWorker));
    $('#pillWorker').title = liveWorker
      ? `Worker ${liveWorker.workerId} — last seen ${liveWorker.secondsSinceLastSeen}s ago`
      : 'No live worker heartbeat';

    if (s.workers?.length) {
      $('#miniOutbox').textContent = '–';
    }
  } catch {
    $('#pillDb').className = 'pill pill-unknown';
    $('#pillMock').className = 'pill pill-unknown';
    $('#pillWorker').className = 'pill pill-unknown';
  }
}

/* ============================== workshops ============================== */
function renderWorkshops() {
  const grid = $('#workshopGrid');
  const q = state.workshopSearch.trim().toLowerCase();
  const items = state.workshops.filter((w) =>
    !q || w.title.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q));

  if (!state.workshops.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
      <h3>No workshops yet</h3>
      <p>${state.identity?.role === 'ORGANIZER' ? 'Create the first workshop to get started.' : 'An organizer needs to create a workshop first.'}</p>
    </div>`;
    return;
  }
  if (!items.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>No matches</h3><p>Try a different search or filter.</p></div>`;
    return;
  }

  grid.innerHTML = items.map((w) => {
    const canRegister = state.identity?.role === 'MEMBER' && w.status === 'ACTIVE';
    const canCancel = state.identity?.role === 'ORGANIZER' && w.status === 'ACTIVE';
    return `
    <article class="ws-card" data-id="${w.id}">
      <div class="ws-card-top">
        <h3 class="ws-title">${esc(w.title)}</h3>
        ${statusPill(w.status)}
      </div>
      <p class="ws-desc">${esc(w.description || 'No description')}</p>
      <div class="ws-meta">
        <span class="meta-item" title="${fmtUtc(w.scheduledAt)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/></svg>
          ${fmtLocal(w.scheduledAt)}
        </span>
        <span class="meta-item">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          ${w.registrationCount ?? 0} registered
        </span>
      </div>
      <div class="ws-actions">
        <button class="btn btn-ghost btn-sm" data-act="detail">Details</button>
        ${canRegister ? `<button class="btn btn-primary btn-sm" data-act="register">Register</button>` : ''}
        ${canCancel ? `<button class="btn btn-danger-ghost btn-sm" data-act="cancel">Cancel workshop</button>` : ''}
      </div>
    </article>`;
  }).join('');

  $$('.ws-card', grid).forEach((card) => {
    const id = card.dataset.id;
    const w = state.workshops.find((x) => x.id === id);
    $$('[data-act]', card).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'detail') await openWorkshopDetail(w);
          if (act === 'register') {
            btn.disabled = true;
            await api(`/api/workshops/${id}/registrations`, { method: 'POST', body: {} });
            toast('success', 'Registered', 'Confirmation notification queued — delivery is independent of this response.');
            await loadWorkshops();
          }
          if (act === 'cancel') {
            confirmModal('Cancel workshop?',
              `Registered members will each receive a durable cancellation notification. This cannot be undone.`,
              'Cancel workshop', async () => {
                const result = await api(`/api/workshops/${id}/cancel`, { method: 'POST', body: {} });
                toast('success', 'Workshop cancelled',
                  result.alreadyCancelled
                    ? 'It was already cancelled — no duplicate notifications created.'
                    : `${result.notificationsCreated} cancellation notification(s) queued.`);
                await loadWorkshops();
              });
          }
        } catch (err) {
          btn.disabled = false;
          toastError(err);
          loadWorkshops();
        }
      });
    });
  });
}

async function openWorkshopDetail(w) {
  const isOrganizer = state.identity?.role === 'ORGANIZER';
  let rosterHtml = '';
  let statusHtml = '';

  if (isOrganizer) {
    try {
      const [roster, status] = await Promise.all([
        api(`/api/workshops/${w.id}/registrations?limit=50`),
        api(`/api/workshops/${w.id}/notification-status`),
      ]);
      rosterHtml = `
        <h3 style="margin:18px 0 8px;font-size:13.5px">Roster (${roster.total})</h3>
        ${roster.items.length ? `
        <div class="table-wrap"><table class="table table-compact">
          <thead><tr><th>Member</th><th>Address</th><th>Registered (UTC)</th></tr></thead>
          <tbody>${roster.items.map((r) => `
            <tr><td>${esc(r.displayName)}</td><td class="mono text-dim">${esc(r.notificationAddress)}</td>
            <td class="mono text-faint">${fmtUtc(r.registeredAt)}</td></tr>`).join('')}
          </tbody></table></div>` : `<p class="hint">No registrations yet.</p>`}
      `;

      const counts = {};
      status.counts.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + c.count; });
      statusHtml = `
        <h3 style="margin:18px 0 8px;font-size:13.5px">Notification status</h3>
        <div class="chips">
          ${['PENDING', 'PROCESSING', 'DELIVERED', 'NEEDS_ATTENTION'].map((s) =>
            `<span class="chip">${s} <strong>${counts[s] || 0}</strong></span>`).join('')}
        </div>`;
    } catch (err) {
      rosterHtml = `<p class="hint">Roster unavailable: ${esc(err.message)}</p>`;
    }
  }

  openModal(w.title, `
    <div class="detail-grid">
      <div class="detail-cell"><div class="k">Status</div><div class="v">${statusPill(w.status)}</div></div>
      <div class="detail-cell"><div class="k">Scheduled (UTC)</div><div class="v mono">${fmtUtc(w.scheduledAt)}</div></div>
      <div class="detail-cell"><div class="k">Created by</div><div class="v">${esc(w.createdBy)}</div></div>
      <div class="detail-cell"><div class="k">Workshop id</div><div class="v mono">${esc(w.id)}</div></div>
    </div>
    <p style="color:var(--text-dim);margin:0">${esc(w.description || 'No description')}</p>
    ${w.status === 'CANCELLED' && w.cancelledAt ? `<p class="hint">Cancelled at ${fmtUtc(w.cancelledAt)}</p>` : ''}
    ${statusHtml}${rosterHtml}`);
}

async function loadWorkshops() {
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (state.workshopFilter) params.set('status', state.workshopFilter);
    const data = await api(`/api/workshops?${params}`);
    state.workshops = data.items;
    renderWorkshops();
  } catch (err) {
    if (err.status !== 401) toastError(err, 'Failed to load workshops');
  }
}

$('#workshopFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  $$('.seg', $('#workshopFilter')).forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.workshopFilter = btn.dataset.status;
  loadWorkshops();
});
$('#workshopSearch').addEventListener('input', (e) => {
  state.workshopSearch = e.target.value;
  renderWorkshops();
});

/* ---------- create workshop ---------- */
$('#newWorkshopBtn').addEventListener('click', () => {
  const defaultWhen = new Date(Date.now() + 7 * 86400_000);
  defaultWhen.setMinutes(0, 0, 0);
  const localValue = new Date(defaultWhen.getTime() - defaultWhen.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
  openModal('New workshop', `
    <form class="form" id="wsForm">
      <label class="field"><span>Title (1–160 chars)</span>
        <input class="input" id="wsTitle" maxlength="160" required placeholder="TypeScript Deep Dive" /></label>
      <label class="field"><span>Description (optional)</span>
        <textarea class="input" id="wsDesc" maxlength="2000" placeholder="What will attendees learn?"></textarea></label>
      <label class="field"><span>Scheduled at (your local time)</span>
        <input class="input" id="wsWhen" type="datetime-local" required value="${localValue}" /></label>
      <div class="btn-row" style="justify-content:flex-end">
        <button type="button" class="btn btn-ghost" id="wsCancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Create workshop</button>
      </div>
    </form>`);
  $('#wsCancel').onclick = closeModal;
  $('#wsForm').onsubmit = async (e) => {
    e.preventDefault();
    const submit = $('#wsForm button[type=submit]');
    submit.disabled = true;
    try {
      const scheduledAt = new Date($('#wsWhen').value).toISOString();
      await api('/api/workshops', {
        method: 'POST',
        body: { title: $('#wsTitle').value.trim(), description: $('#wsDesc').value.trim() || null, scheduledAt },
      });
      toast('success', 'Workshop created', 'It is now open for registrations.');
      closeModal();
      await loadWorkshops();
    } catch (err) {
      submit.disabled = false;
      toastError(err, 'Could not create workshop');
    }
  };
});

/* ============================== notifications ============================== */
async function loadNotifications() {
  if (state.identity?.role !== 'ORGANIZER') {
    $('#notifTbody').innerHTML = `<tr><td colspan="7" class="text-faint" style="text-align:center;padding:26px">
      The notification outbox is visible to organizers. Switch to an organizer identity.</td></tr>`;
    $('#outboxStats').innerHTML = '';
    return;
  }
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (state.notifFilter.status) params.set('status', state.notifFilter.status);
    if (state.notifFilter.type) params.set('type', state.notifFilter.type);
    if (state.notifFilter.search) params.set('search', state.notifFilter.search);
    const data = await api(`/api/notifications?${params}`);
    state.notifications = data;

    const counts = {};
    data.statusCounts.forEach((c) => { counts[c.status] = c.count; });
    $('#outboxStats').innerHTML = ['PENDING', 'PROCESSING', 'DELIVERED', 'NEEDS_ATTENTION'].map((s) => `
      <span class="chip">${s} <strong>${counts[s] || 0}</strong></span>`).join('');

    const badge = $('#navBadgePending');
    const attention = (counts.NEEDS_ATTENTION || 0) + (counts.PENDING || 0);
    badge.hidden = attention === 0;
    badge.textContent = attention;

    $('#miniOutbox').textContent = String(data.statusCounts.reduce((a, c) => a + c.count, 0));

    const tbody = $('#notifTbody');
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-faint" style="text-align:center;padding:26px">
        No notification events match the current filters.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.items.map((e) => `
      <tr data-id="${e.id}">
        <td>
          <div style="font-weight:620">${e.type === 'REGISTRATION_CONFIRMED' ? 'Confirmation' : 'Cancellation'}</div>
          <div class="text-faint mono" style="font-size:11px">${e.type}</div>
        </td>
        <td>
          <div>${esc(e.recipientName)}</div>
          <div class="text-faint mono" style="font-size:11px">${shortId(e.recipientId)}…</div>
        </td>
        <td>${statusPill(e.status)}</td>
        <td class="mono">${e.attemptCount}</td>
        <td class="text-dim" title="${fmtUtc(e.nextAttemptAt)}">${e.status === 'PENDING' ? fmtRelative(e.nextAttemptAt) : '–'}</td>
        <td><div class="err-cell" title="${esc(e.lastError || '')}">${esc(e.lastError || '–')}</div></td>
        <td class="td-actions">
          <button class="btn btn-ghost btn-sm" data-act="detail">Details</button>
          ${e.status === 'NEEDS_ATTENTION' ? `<button class="btn btn-primary btn-sm" data-act="requeue">Requeue</button>` : ''}
        </td>
      </tr>`).join('');

    $$('tr[data-id]', tbody).forEach((tr) => {
      const id = tr.dataset.id;
      const ev = data.items.find((x) => x.id === id);
      $$('[data-act]', tr).forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.act === 'detail') {
            await openEventDetail(id);
          } else if (btn.dataset.act === 'requeue') {
            btn.disabled = true;
            try {
              await api(`/api/notifications/${id}/retry`, { method: 'POST', body: {} });
              toast('success', 'Event requeued', 'It will be picked up by the next worker cycle.');
              await loadNotifications();
            } catch (err) {
              btn.disabled = false;
              toastError(err, 'Requeue failed');
            }
          }
        });
      });
      void ev;
    });
  } catch (err) {
    toastError(err, 'Failed to load notifications');
  }
}

async function openEventDetail(id) {
  try {
    const e = await api(`/api/notifications/${id}`);
    const attempts = (e.attempts || []).map((a) => {
      const cls = a.outcome === 'SUCCESS' ? 'ok' : a.outcome === 'RETRY_SCHEDULED' ? 'retry' : 'fail';
      return `<li class="${cls}">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <strong>Attempt ${a.attemptNumber}</strong>
          ${a.outcome ? statusPill(a.outcome) : '<span class="status-pill s-processing">RUNNING</span>'}
          <span class="text-faint mono" style="font-size:11px">${fmtUtc(a.startedAt)}${a.finishedAt ? ' → ' + fmtUtc(a.finishedAt) : ''}</span>
          ${a.httpStatus ? `<span class="chip">HTTP ${a.httpStatus}</span>` : ''}
        </div>
        ${a.error ? `<div class="err-cell" style="max-width:none;white-space:normal;margin-top:4px">${esc(a.error)}</div>` : ''}
      </li>`;
    }).join('');

    openModal('Notification event', `
      <div class="detail-grid">
        <div class="detail-cell"><div class="k">Status</div><div class="v">${statusPill(e.status)}</div></div>
        <div class="detail-cell"><div class="k">Type</div><div class="v mono" style="font-size:11px">${e.type}</div></div>
        <div class="detail-cell"><div class="k">Attempts</div><div class="v mono">${e.attemptCount}</div></div>
        <div class="detail-cell"><div class="k">Next attempt</div><div class="v mono">${fmtUtc(e.nextAttemptAt)}</div></div>
        <div class="detail-cell"><div class="k">Event id</div><div class="v mono" style="font-size:10.5px">${esc(e.id)}</div></div>
        <div class="detail-cell"><div class="k">Dedupe key</div><div class="v mono" style="font-size:10.5px">${esc(e.dedupeKey)}</div></div>
      </div>
      ${e.lastError ? `<p class="hint" style="color:var(--red)">Last error: ${esc(e.lastError)}</p>` : ''}
      <h3 style="margin:16px 0 4px;font-size:13.5px">Attempts</h3>
      ${attempts ? `<ul class="timeline">${attempts}</ul>` : '<p class="hint">No attempts yet.</p>'}
      <h3 style="margin:16px 0 4px;font-size:13.5px">Payload snapshot</h3>
      <pre class="code">${esc(JSON.stringify(e.payload, null, 2))}</pre>
      ${e.status === 'NEEDS_ATTENTION' ? `
      <div class="btn-row" style="justify-content:flex-end">
        <button class="btn btn-primary" id="modalRequeue">Requeue event</button>
      </div>` : ''}`);

    const requeueBtn = $('#modalRequeue');
    if (requeueBtn) {
      requeueBtn.onclick = async () => {
        requeueBtn.disabled = true;
        try {
          await api(`/api/notifications/${id}/retry`, { method: 'POST', body: {} });
          toast('success', 'Event requeued');
          closeModal();
          await loadNotifications();
        } catch (err) { toastError(err, 'Requeue failed'); requeueBtn.disabled = false; }
      };
    }
  } catch (err) {
    toastError(err, 'Failed to load event');
  }
}

$('#notifStatusFilter').addEventListener('change', (e) => { state.notifFilter.status = e.target.value; loadNotifications(); });
$('#notifTypeFilter').addEventListener('change', (e) => { state.notifFilter.type = e.target.value; loadNotifications(); });
$('#notifSearch').addEventListener('input', (e) => { state.notifFilter.search = e.target.value; loadNotifications(); });

/* ============================== mock & faults ============================== */
const FAULT_MODE_FIELDS = {
  fail_first_n: [{ key: 'failFirstN', label: 'Fail first N', type: 'number', value: 2 }],
  timeout_before_commit: [{ key: 'hangMs', label: 'Hang (ms)', type: 'number', value: 5000 }],
  commit_then_timeout: [{ key: 'hangMs', label: 'Hang (ms)', type: 'number', value: 5000 }],
  seeded_random: [
    { key: 'failureRate', label: 'Failure rate (0–1)', type: 'number', value: 0.3, step: '0.1' },
    { key: 'seed', label: 'Seed', type: 'number', value: 42 },
  ],
};

function replaceScopeControl(html) {
  const old = $('#faultScopeRecipient');
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const next = tmp.firstElementChild;
  next.id = 'faultScopeRecipient';
  old.replaceWith(next);
}

function renderFaultForm() {
  const mode = $('#faultMode').value;
  const fields = FAULT_MODE_FIELDS[mode] || [];
  $('#faultModeFields').innerHTML = fields.map((f) => `
    <label class="field"><span>${f.label}</span>
      <input class="input" type="number" data-key="${f.key}" value="${f.value}" ${f.step ? `step="${f.step}"` : ''} /></label>`).join('');

  const kind = $('#faultScopeKind').value;
  const wrap = $('#faultScopeValueWrap');
  if (kind === 'global') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  if (kind === 'recipient') {
    $('#faultScopeValueLabel').textContent = 'Recipient';
    const options = state.personas
      .filter((p) => p.memberId)
      .map((p) => `<option value="${p.memberId}">${esc(p.label)}</option>`)
      .join('');
    replaceScopeControl(`<select class="select">${options}</select>`);
  } else {
    $('#faultScopeValueLabel').textContent = 'Event id';
    replaceScopeControl(`<input class="select" placeholder="event uuid" />`);
  }
}
$('#faultMode').addEventListener('change', renderFaultForm);
$('#faultScopeKind').addEventListener('change', renderFaultForm);

async function loadMock() {
  if (state.identity?.role !== 'ORGANIZER') {
    $('#mockStats').innerHTML = '';
    $('#counterGrid').innerHTML = '<p class="hint">Organizer identity required.</p>';
    return;
  }
  try {
    const [stats, receipts] = await Promise.all([
      api('/api/mock/stats'),
      api('/api/mock/receipts?limit=30'),
    ]);
    state.mockStats = stats;
    state.mockFaults = stats.faultState;
    state.receipts = receipts;

    $('#miniReceipts').textContent = String(stats.receiptCount);
    $('#mockStats').innerHTML = `
      <span class="chip">receipts <strong>${stats.receiptCount}</strong></span>
      <span class="chip">received <strong>${stats.counters.received}</strong></span>
      <span class="chip">faults injected <strong>${stats.counters.faultsInjected}</strong></span>`;

    const c = stats.counters;
    $('#counterGrid').innerHTML = [
      ['Received', c.received], ['Accepted', c.accepted],
      ['Duplicates suppressed', c.duplicatesSuppressed], ['Payload mismatches', c.payloadMismatches],
      ['Faults injected', c.faultsInjected], ['Stored receipts', stats.receiptCount],
    ].map(([label, value]) => `
      <div class="counter"><div class="c-label">${label}</div><div class="c-value">${value}</div></div>`).join('');

    $('#faultState').textContent = JSON.stringify(stats.faultState, null, 2);

    const tbody = $('#receiptsTbody');
    if (!receipts.items.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-faint" style="text-align:center;padding:22px">No receipts yet — deliver a notification first.</td></tr>`;
    } else {
      tbody.innerHTML = receipts.items.map((r) => `
        <tr>
          <td class="mono" title="${esc(r.idempotencyKey)}">${shortId(r.idempotencyKey)}…</td>
          <td class="mono" style="font-size:11px">${esc(r.payload?.type || '–')}</td>
          <td class="mono text-dim" style="font-size:11px">${shortId(r.payload?.recipientId)}…</td>
          <td class="mono text-faint">${fmtUtc(r.receivedAt)}</td>
        </tr>`).join('');
    }
  } catch (err) {
    toastError(err, 'Mock service unavailable');
  }
}

$('#faultForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = $('#faultMode').value;
  const kind = $('#faultScopeKind').value;
  const scope = { kind };
  if (kind === 'recipient') scope.recipientId = $('#faultScopeRecipient').value;
  if (kind === 'event') scope.eventId = $('#faultScopeRecipient').value;

  const body = { mode, scope };
  $$('#faultModeFields [data-key]').forEach((input) => {
    const key = input.dataset.key;
    const raw = input.value;
    if (raw === '') return;
    body[key] = key === 'failureRate' ? Number(raw) : parseInt(raw, 10);
  });

  try {
    await api('/api/mock/faults', { method: 'PUT', body });
    toast('success', 'Fault applied', `Mode: ${mode}`);
    await loadMock();
  } catch (err) { toastError(err, 'Could not apply fault'); }
});

$('#clearFaultBtn').addEventListener('click', async () => {
  try {
    await api('/api/mock/faults', { method: 'PUT', body: { mode: 'always_success' } });
    toast('success', 'Faults cleared', 'Service back to always_success.');
    await loadMock();
  } catch (err) { toastError(err); }
});

$('#resetFixturesBtn').addEventListener('click', () => {
  confirmModal('Reset mock fixtures?',
    'This clears the current fault rule and (optionally) all stored delivery receipts. Counters reset to zero.',
    'Reset including receipts', async () => {
      await api('/api/mock/reset', { method: 'POST', body: { clearReceipts: true } });
      toast('success', 'Fixtures reset');
      await loadMock();
    });
});

$('#refreshReceiptsBtn').addEventListener('click', loadMock);

/* ============================== refresh loop ============================== */
async function refreshAll() {
  refreshHealth();
  if (!state.identity) return;
  if (state.tab === 'workshops') loadWorkshops();
  if (state.tab === 'notifications') loadNotifications();
  if (state.tab === 'mock') loadMock();
}

function startPolling() {
  clearInterval(state.pollTimer);
  if ($('#autoRefresh').checked) {
    state.pollTimer = setInterval(() => {
      if (document.hidden) return;
      if ($('#modalBackdrop').hidden === false) return; // don't disturb open modals
      refreshAll();
    }, 5000);
  }
}
$('#autoRefresh').addEventListener('change', startPolling);

/* ============================== boot ============================== */
async function boot() {
  renderFaultForm();
  try {
    const data = await api('/api/demo/personas');
    state.personas = data.personas;
  } catch {
    state.personas = [];
  }

  const saved = localStorage.getItem('wr-token');
  if (saved && state.personas.length) {
    const match = state.personas.find((p) => p.token === saved);
    if (match) state.identity = match;
    else state.identity = { label: 'Custom', role: 'UNKNOWN', token: saved, memberId: null };
    try {
      const me = await api('/api/demo/whoami');
      state.identity = { label: me.label, role: me.role, memberId: me.memberId, token: saved };
    } catch {
      state.identity = null;
      localStorage.removeItem('wr-token');
    }
  }

  renderPersona();
  renderGate();
  await refreshAll();
  startPolling();
}

boot();
