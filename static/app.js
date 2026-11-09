/* Crags Job Log - single page frontend (no build step). */
'use strict';

const $app = document.getElementById('app');
const S = { me: null, group: null, pub: null, pendingCount: 0 };

const STATUS = {
  contacted:   { label: 'Contacted',   cls: 'blue' },
  replied:     { label: 'Replied',     cls: 'violet' },
  in_progress: { label: 'In progress', cls: 'amber' },
  success:     { label: 'Successful',  cls: 'green' },
  closed:      { label: 'Closed',      cls: '' },
};
const SCOPE_LABEL = { own: 'Own logs only', group: "Own group's logs", all: 'All logs' };
const ROLE_LABEL = { member: 'Member', leader: 'Group leader', admin: 'Administrator' };
const ROLE_BADGE = { member: '', leader: 'violet', admin: 'blue' };
const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All time']];

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

async function api(method, url, data) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'crags' } };
  if (data !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('Cannot reach the server'); }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && S.me && !url.startsWith('/api/auth/')) {
    S.me = null;
    renderAuth('Your session has ended. Please sign in again.');
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error((json && json.error) || `Request failed (${res.status})`);
  return json;
}
const GET = (u) => api('GET', u);
const POST = (u, d) => api('POST', u, d || {});
const PUT = (u, d) => api('PUT', u, d || {});
const DEL = (u) => api('DELETE', u);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (['checked', 'selected', 'disabled', 'readOnly', 'required', 'multiple'].includes(k)) el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}
function append(el, kids) {
  for (const k of [kids].flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 5000 : 2600);
}
const ok = (m) => toast(m, 'ok');
const fail = (e) => toast(e && e.message ? e.message : String(e), 'error');

function parseUtc(s) { return s ? new Date(s.replace(' ', 'T') + 'Z') : null; }
function fmtDate(s) {
  const d = parseUtc(s); if (!d) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(s) {
  const d = parseUtc(s); if (!d) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtRel(s) {
  const d = parseUtc(s); if (!d) return '—';
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return fmtDate(s);
}
function toUtcString(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }
function localDayBound(dateStr, end) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = end ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
  return toUtcString(dt);
}
function fmtNum(n) { n = Number(n || 0); return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1); }
function initials(name) {
  const parts = String(name || '?').replace(/^\d+-/, '').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function groupLabel(n, name) { return name ? `Group ${n} · ${name}` : `Group ${n}`; }
function isAdmin() { return S.me && S.me.role === 'admin'; }
function isLeader() { return S.me && S.me.role === 'leader'; }
function statusBadge(st) { const s = STATUS[st] || STATUS.contacted; return h('span', { class: `badge ${s.cls}` }, s.label); }

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label, hint ? h('span', { class: 'hint' }, ' ', hint) : null), input);
}
function select(options, value, attrs = {}) {
  return h('select', { ...attrs, value: value == null ? '' : String(value) },
    options.map(([v, l]) => h('option', { value: String(v) }, l)));
}
function switchEl(checked, onchange) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked, e.target) });
  return h('label', { class: 'switch' }, input, h('span'));
}
function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const [v, l] of options) {
    wrap.append(h('button', { type: 'button', class: String(v) === String(value) ? 'on' : '', onclick: () => onChange(v) }, l));
  }
  return wrap;
}
function loading(text = 'Loading…') { return h('div', { class: 'loading-block' }, h('span', { class: 'spinner' }), ' ', text); }
function emptyState(icon, title, sub) {
  return h('div', { class: 'empty' }, h('div', { class: 'big' }, icon), h('div', null, h('b', null, title)), sub ? h('div', { class: 'small' }, sub) : null);
}
function statCard(label, value, sub, accent) {
  return h('div', { class: `stat ${accent ? 'accent' : ''}` },
    h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}
function pageHead(title, sub, ...right) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null),
    right.length ? h('div', { class: 'row' }, right) : null);
}

/* Modal ------------------------------------------------------------ */
function modal({ title, body, actions = [], wide = false }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) {
    const b = h('button', { type: 'button', class: `btn ${a.class || ''}` }, a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try { const r = await a.onClick(close); if (r !== false) close(); }
      catch (e) { fail(e); }
      finally { b.disabled = false; }
    });
    foot.append(b);
  }
  const m = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn ghost sm', onclick: close, 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.append(m);
  document.body.append(back);
  const first = m.querySelector('input:not([type=hidden]):not([readonly]), textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: m };
}
function confirmDialog(message, { okLabel = 'Confirm', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: h('p', { style: { margin: 0 } }, message),
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, class: danger ? 'danger solid' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

/* Chat paste parser -------------------------------------------------
   One message per line, prefixed "Me:" or "Them:" (or the contact's name).
   Lines without a prefix continue the previous message.                 */
function parseChat(text, contactName) {
  const out = [];
  const names = ['them', 'they', 'contact', 'client', 'customer', 'him', 'her'];
  if (contactName) names.push(contactName.trim().split(/\s+/)[0], contactName.trim());
  const esc = names.filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`^\\s*(me|i|${esc})\\s*[:：]\\s?(.*)$`, 'i');
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(re);
    if (m) out.push({ sender: /^(me|i)$/i.test(m[1]) ? 'me' : 'contact', content: m[2] });
    else if (out.length) out[out.length - 1].content += '\n' + line;
    else if (line.trim()) out.push({ sender: 'contact', content: line });
  }
  return out.map((x) => ({ ...x, content: x.content.trim() })).filter((x) => x.content);
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function renderAuth(message) {
  let mode = 'login';
  const card = h('div', { class: 'card auth-card' });
  const draw = () => {
    clear(card);
    const pad = h('div', { class: 'card-pad' });
    pad.append(h('div', { class: 'auth-brand' }, h('div', { class: 'brand-mark' }, '▲'), 'Crags Job Log'));
    pad.append(h('div', { class: 'tabs' },
      h('button', { class: mode === 'login' ? 'on' : '', onclick: () => { mode = 'login'; message = null; draw(); } }, 'Sign in'),
      h('button', { class: mode === 'signup' ? 'on' : '', onclick: () => { mode = 'signup'; message = null; draw(); } }, 'Sign up')));
    const msgBox = h('div');
    if (message) msgBox.append(h('div', { class: `notice ${message.type || 'warn'}` }, message.text || message));
    pad.append(msgBox);
    const showMsg = (text, type = 'error') => { clear(msgBox).append(h('div', { class: `notice ${type}` }, text)); };

    if (mode === 'login') {
      const u = h('input', { type: 'text', autocomplete: 'username', placeholder: 'e.g. 3-ALEX', required: true });
      const p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
      const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Sign in');
      pad.append(h('form', {
        class: 'stack', style: { marginTop: '12px' },
        onsubmit: async (e) => {
          e.preventDefault(); btn.disabled = true;
          try { await POST('/api/auth/login', { username: u.value, password: p.value }); await boot(); }
          catch (err) { showMsg(err.message); }
          finally { btn.disabled = false; }
        },
      }, field('Username', u), field('Password', p), btn));
    } else if (!S.pub.signup_enabled) {
      pad.append(h('div', { class: 'notice warn', style: { marginTop: '12px' } },
        'Sign up is currently disabled by the administrator. Please contact your group leader or administrator to get an account.'));
    } else {
      const u = h('input', { type: 'text', autocomplete: 'username', placeholder: '3-ALEX', required: true, pattern: '\\d{1,4}-[A-Za-z0-9_.]{1,32}' });
      const p = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
      const p2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
      const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Create account');
      pad.append(h('form', {
        class: 'stack', style: { marginTop: '12px' },
        onsubmit: async (e) => {
          e.preventDefault();
          if (p.value !== p2.value) return showMsg('Passwords do not match');
          btn.disabled = true;
          try {
            const r = await POST('/api/auth/signup', { username: u.value, password: p.value });
            if (r.pending) { mode = 'login'; message = { text: r.message, type: 'ok' }; draw(); }
            else await boot();
          } catch (err) { showMsg(err.message); }
          finally { btn.disabled = false; }
        },
      },
      field('Username', u, '— group number, dash, name (3-ALEX joins group 3)'),
      field('Password', p, '— at least 6 characters'), field('Confirm password', p2),
      S.pub.require_approval ? h('div', { class: 'notice info' }, 'New accounts must be approved by an administrator before first sign-in.') : null,
      btn));
    }
    card.append(pad);
  };
  draw();
  clear($app).append(h('div', { class: 'auth-wrap' }, card));
}

/* ------------------------------------------------------------------ */
/* Shell & routing                                                     */
/* ------------------------------------------------------------------ */

const ROUTES = {
  '/dashboard': pageDashboard,
  '/submit': pageSubmit,
  '/jobs': pageJobs,
  '/competition': pageCompetition,
  '/profile': pageProfile,
  '/admin/users': pageAdminUsers,
  '/admin/groups': pageAdminGroups,
  '/admin/settings': pageAdminSettings,
};
let mainEl = null;
let shellEl = null;
let routeToken = 0;

function navItems() {
  const items = [
    ['/dashboard', '◧', 'Dashboard'],
    ['/submit', '＋', 'Submit job'],
    ['/jobs', '☰', 'Job logs'],
    ['/competition', '🏆', 'Competition'],
  ];
  const admin = isAdmin() ? [
    ['/admin/users', '👤', 'Users', S.pendingCount],
    ['/admin/groups', '◫', 'Groups'],
    ['/admin/settings', '⚙', 'Settings'],
  ] : [];
  return { items, admin };
}

function renderShell() {
  const { items, admin } = navItems();
  const link = ([path, ico, label, count]) =>
    h('a', { href: `#${path}`, 'data-path': path, onclick: () => shellEl.classList.remove('nav-open') },
      h('span', { class: 'ico' }, ico), label, count ? h('span', { class: 'count' }, count) : null);
  const me = S.me;
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '▲'), 'Crags Job Log'),
    h('nav', { class: 'nav' }, items.map(link),
      admin.length ? [h('div', { class: 'nav-section' }, 'Administration'), admin.map(link)] : null),
    h('div', { class: 'sidebar-foot' },
      h('a', { href: '#/profile', class: 'user-chip', style: { color: 'inherit', textDecoration: 'none' } },
        h('div', { class: 'avatar' }, initials(me.username)),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: 600 } }, me.username),
          h('div', { class: 'small muted' }, ROLE_LABEL[me.role], me.group_number != null ? ` · Group ${me.group_number}` : ''))),
      h('button', {
        class: 'btn ghost sm', style: { marginTop: '10px', width: '100%' },
        onclick: async () => { await POST('/api/auth/logout').catch(() => {}); S.me = null; location.hash = ''; renderAuth(); },
      }, 'Sign out')));
  mainEl = h('main', { class: 'main' });
  shellEl = h('div', { class: 'shell' },
    sidebar,
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'mobile-bar' },
        h('button', { class: 'btn sm', onclick: () => shellEl.classList.toggle('nav-open') }, '☰'),
        h('b', null, 'Crags Job Log')),
      mainEl));
  clear($app).append(shellEl);
}

function parseHash() {
  const raw = location.hash.slice(1) || '';
  const [path, qs] = raw.split('?');
  return { path: path || '', params: new URLSearchParams(qs || '') };
}
function setHashParams(path, params, replace = true) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) qs.set(k, v);
  const url = `#${path}${qs.toString() ? '?' + qs : ''}`;
  if (replace) history.replaceState(null, '', url); else location.hash = url;
}

async function route() {
  if (!S.me) return;
  let { path, params } = parseHash();
  if (!ROUTES[path] || (path.startsWith('/admin') && !isAdmin())) {
    path = '/dashboard';
    params = new URLSearchParams();
    history.replaceState(null, '', `#${path}`);
  }
  for (const a of shellEl.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.path === path);
  const token = ++routeToken;
  const container = h('div');
  clear(mainEl).append(container);
  window.scrollTo(0, 0);
  try { await ROUTES[path](container, params, () => token === routeToken); }
  catch (e) { if (token === routeToken) { container.append(h('div', { class: 'notice error' }, e.message)); } }
}
window.addEventListener('hashchange', route);

async function refreshPending() {
  if (!isAdmin()) return;
  try {
    const { users } = await GET('/api/admin/users');
    S.pendingCount = users.filter((u) => !u.active && !u.last_login).length;
    const a = shellEl && shellEl.querySelector('a[data-path="/admin/users"]');
    if (a) {
      const old = a.querySelector('.count'); if (old) old.remove();
      if (S.pendingCount) a.append(h('span', { class: 'count' }, S.pendingCount));
    }
  } catch { /* ignore */ }
}

async function boot() {
  try {
    S.pub = await GET('/api/public/settings');
    const r = await GET('/api/auth/me');
    S.me = r.user; S.group = r.group;
  } catch (e) {
    clear($app).append(h('div', { class: 'boot' }, 'Cannot reach the server. ', e.message));
    return;
  }
  if (!S.me) return renderAuth();
  renderShell();
  refreshPending();
  route();
}

/* ------------------------------------------------------------------ */
/* Charts / shared stat views                                          */
/* ------------------------------------------------------------------ */

function trendChart(trend) {
  const max = Math.max(1, ...trend.map((d) => d.jobs + d.contacts));
  const chart = h('div', { class: 'trend' });
  for (const d of trend) {
    const label = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    chart.append(h('div', { class: 'day', 'data-tip': `${label}\n${d.jobs} jobs · ${d.contacts} people` },
      h('div', { class: 'bar contacts', style: { height: `${(d.contacts / max) * 100}%` } }),
      h('div', { class: 'bar jobs', style: { height: `${(d.jobs / max) * 100}%` } })));
  }
  const lbl = (d) => new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return h('div', null,
    h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--primary)' } }), 'Jobs submitted'),
      h('span', null, h('i', { style: { background: '#9cbcf8' } }), 'People contacted')),
    chart,
    trend.length ? h('div', { class: 'trend-axis' }, h('span', null, lbl(trend[0])),
      trend.length > 2 ? h('span', null, lbl(trend[Math.floor(trend.length / 2)])) : null,
      h('span', null, lbl(trend[trend.length - 1]))) : null);
}

function periodPicker(days, onChange) {
  return seg(PERIODS, days, onChange);
}
function periodText(days) {
  return days === 1 ? 'the last 24 hours' : days === 0 ? 'all time' : `the last ${days} days`;
}
function pointsText(p) {
  return `Points: ${fmtNum(p.job)} per job · ${fmtNum(p.contact)} per person contacted · ${fmtNum(p.success)} per successful contact`;
}

function memberPerformanceTable(members, days) {
  if (!members.length) return emptyState('👥', 'No members in this group yet');
  const max = Math.max(1, ...members.map((m) => m.points));
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, '#'), h('th', null, 'Member'), h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num' }, 'People'),
      h('th', { class: 'num' }, 'Successful'), h('th', { class: 'num' }, 'Messages'), h('th', null, 'Points'),
      h('th', null, 'Last submission'), h('th'))),
    h('tbody', null, members.map((m, i) => h('tr', { class: S.me.id === m.id ? 'me-row' : '' },
      h('td', null, h('div', { class: `rank ${i < 3 && m.points > 0 ? 'r' + (i + 1) : ''}` }, i + 1)),
      h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        h('div', { class: 'avatar alt' }, initials(m.username)),
        h('div', null, h('b', null, m.username), ' ', m.role === 'leader' ? h('span', { class: 'badge violet' }, 'Leader') : null,
          !m.active ? h('span', { class: 'badge red' }, 'Disabled') : null))),
      h('td', { class: 'num' }, m.jobs), h('td', { class: 'num' }, m.contacts),
      h('td', { class: 'num' }, m.successes), h('td', { class: 'num' }, m.messages),
      h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        h('b', { style: { minWidth: '36px' } }, fmtNum(m.points)),
        h('div', { class: 'meter grow' }, h('span', { style: { width: `${(m.points / max) * 100}%` } })))),
      h('td', { class: 'nowrap muted' }, m.last_submission ? fmtRel(m.last_submission) : 'never'),
      h('td', null, h('a', { class: 'btn xs', href: `#/jobs?user_id=${m.id}` }, 'Logs →')))))));
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function pageDashboard(root, params, alive) {
  const days = params.has('days') ? Number(params.get('days')) : 7;
  const groupParam = params.get('group') || '';
  const go = (p) => setHashParams('/dashboard', { days, group: groupParam, ...p }, false);

  root.append(pageHead('Dashboard', `Performance for ${periodText(days)}`, periodPicker(days, (d) => go({ days: d }))));
  const body = h('div', { class: 'stack', style: { gap: '20px' } }, loading());
  root.append(body);

  if (isAdmin()) {
    const comp = await GET(`/api/stats/competition?days=${days}`);
    if (!alive()) return;
    clear(body);
    const tot = comp.groups.reduce((a, g) => ({
      jobs: a.jobs + g.jobs, contacts: a.contacts + g.contacts, successes: a.successes + g.successes, members: a.members + g.members,
    }), { jobs: 0, contacts: 0, successes: 0, members: 0 });
    body.append(h('div', { class: 'stats', style: { marginBottom: 0 } },
      statCard('Jobs submitted', fmtNum(tot.jobs), 'all groups', true),
      statCard('People contacted', fmtNum(tot.contacts)),
      statCard('Successful contacts', fmtNum(tot.successes)),
      statCard('Active members', fmtNum(tot.members), `${comp.groups.length} groups`)));

    const groupSel = select([['', 'Choose a group…'], ...comp.groups.map((g) => [g.number, groupLabel(g.number, g.name)])], groupParam,
      { class: 'compact', onchange: (e) => go({ group: e.target.value }) });
    const groupsCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Groups overview'), h('a', { href: '#/competition', class: 'btn sm' }, 'Competition →')),
      comp.groups.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Group'), h('th', null, 'Leader(s)'), h('th', { class: 'num' }, 'Members'),
          h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num' }, 'People'), h('th', { class: 'num' }, 'Successful'),
          h('th', { class: 'num' }, 'Points'), h('th'))),
        h('tbody', null, comp.groups.map((g) => h('tr', { class: String(g.number) === groupParam ? 'me-row' : '' },
          h('td', null, h('b', null, groupLabel(g.number, g.name))),
          h('td', { class: 'muted' }, g.leaders || '—'),
          h('td', { class: 'num' }, g.members), h('td', { class: 'num' }, g.jobs), h('td', { class: 'num' }, g.contacts),
          h('td', { class: 'num' }, g.successes), h('td', { class: 'num' }, h('b', null, fmtNum(g.points))),
          h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } },
            h('button', { class: 'btn xs', onclick: () => go({ group: g.number }) }, 'Members'),
            h('a', { class: 'btn xs', href: `#/jobs?group=${g.number}` }, 'Logs →')))))))) :
        emptyState('◫', 'No groups yet', 'Groups appear automatically when users sign up (3-XXX joins group 3).'));
    body.append(groupsCard);
    if (groupParam) await groupSection(body, groupParam, days, alive, groupSel);
    else body.append(h('div', { class: 'card card-pad row' }, h('span', { class: 'muted' }, 'Member performance:'), groupSel));
    return;
  }

  const meData = await GET(`/api/stats/me?days=${days}`);
  if (!alive()) return;
  clear(body);
  const st = meData.stats;
  body.append(h('div', null,
    h('h2', { style: { marginBottom: '10px' } }, 'My performance'),
    h('div', { class: 'stats', style: { marginBottom: 0 } },
      statCard('Points', fmtNum(st.points), meData.group_rank ? `#${meData.group_rank.position} of ${meData.group_rank.of} in group ${S.me.group_number}` : '', true),
      statCard('Jobs submitted', fmtNum(st.jobs)),
      statCard('People contacted', fmtNum(st.contacts)),
      statCard('Successful', fmtNum(st.successes)),
      statCard('Messages logged', fmtNum(st.messages)))));

  if (isLeader()) {
    await groupSection(body, S.me.group_number, days, alive);
  } else {
    body.append(h('div', { class: 'two-col' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'My activity')),
        h('div', { class: 'card-pad' }, trendChart(meData.trend))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Quick actions')),
        h('div', { class: 'card-pad stack' },
          h('a', { class: 'btn primary', href: '#/submit' }, '＋ Submit a new job'),
          h('a', { class: 'btn', href: '#/jobs?view=mine' }, 'View my job logs'),
          h('a', { class: 'btn', href: '#/competition' }, 'See group competition'),
          h('div', { class: 'small muted' }, pointsText(meData.points))))));
  }
}

async function groupSection(body, group, days, alive, groupSel) {
  const holder = h('div', null, loading());
  body.append(holder);
  let data;
  try { data = await GET(`/api/stats/group?days=${days}${isAdmin() ? `&group=${group}` : ''}`); }
  catch (e) { clear(holder).append(h('div', { class: 'notice error' }, e.message)); return; }
  if (!alive()) return;
  clear(holder);
  const t = data.totals;
  holder.append(h('div', { class: 'stack', style: { gap: '16px' } },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h2', null, `${groupLabel(data.group.number, data.group.name)} — member performance`), groupSel || null),
    h('div', { class: 'stats', style: { marginBottom: 0 } },
      statCard('Group points', fmtNum(t.points), `${t.members} active members`, true),
      statCard('Jobs submitted', fmtNum(t.jobs)),
      statCard('People contacted', fmtNum(t.contacts)),
      statCard('Successful', fmtNum(t.successes)),
      statCard('Avg points / member', t.members ? fmtNum(t.points / t.members) : '0')),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Members ranking'),
        h('a', { class: 'btn sm', href: `#/jobs?${isAdmin() ? 'group=' + data.group.number : 'view=group'}` }, 'All group logs →')),
      memberPerformanceTable(data.members, days),
      h('div', { class: 'small muted', style: { padding: '10px 16px', borderTop: '1px solid var(--border)' } }, pointsText(data.points))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Daily activity')),
      h('div', { class: 'card-pad' }, trendChart(data.trend)))));
}

/* ------------------------------------------------------------------ */
/* Submit page                                                         */
/* ------------------------------------------------------------------ */

function contactFormFields(c = {}) {
  const f = {
    name: h('input', { type: 'text', value: c.name || '', placeholder: 'Person name', required: true }),
    contact_info: h('input', { type: 'text', value: c.contact_info || '', placeholder: 'Email, phone, profile link…' }),
    platform: h('input', { type: 'text', value: c.platform || '', placeholder: 'e.g. Email, LinkedIn, Telegram', list: 'dl-platforms' }),
    status: select(Object.entries(STATUS).map(([k, v]) => [k, v.label]), c.status || 'contacted'),
    notes: h('textarea', { rows: 2, placeholder: 'Notes (optional)' }, c.notes || ''),
  };
  const grid = h('div', { class: 'form-grid' },
    field('Name *', f.name), field('Contact info', f.contact_info),
    field('Platform', f.platform), field('Status', f.status),
    h('div', { class: 'full' }, field('Notes', f.notes)),
    h('datalist', { id: 'dl-platforms' }, ['Email', 'Phone', 'LinkedIn', 'Telegram', 'WhatsApp', 'Discord', 'Slack', 'Skype', 'Upwork', 'Other']
      .map((p) => h('option', { value: p }))));
  const values = () => ({
    name: f.name.value, contact_info: f.contact_info.value, platform: f.platform.value,
    status: f.status.value, notes: f.notes.value,
  });
  return { grid, f, values };
}

function chatPasteField() {
  const ta = h('textarea', { rows: 5, placeholder: 'Me: Hi, I saw your job post…\nThem: Thanks! Can you share your portfolio?\nMe: Sure, here it is…' });
  const preview = h('div', { class: 'small muted' }, 'One message per line, starting with "Me:" or "Them:" (or the person\'s name). Lines without a prefix continue the previous message.');
  return { el: h('div', { class: 'stack', style: { gap: '6px' } }, field('Chat history (optional)', ta), preview), ta, preview };
}

async function pageSubmit(root) {
  const meta = await GET('/api/meta').catch(() => ({ job_types: [], locations: [] }));
  root.append(pageHead('Submit a job', 'Log a job you applied to and the people you contacted through it.'));

  const result = h('div');
  const f = {
    name: h('input', { type: 'text', value: S.me.username, readOnly: true }),
    crag_username: h('input', { type: 'text', placeholder: 'Optional' }),
    location: h('input', { type: 'text', list: 'dl-locations', placeholder: 'City, country or Remote' }),
    job_type: h('input', { type: 'text', list: 'dl-jobtypes', placeholder: 'e.g. Full-time, Contract, Freelance' }),
    job_title: h('input', { type: 'text', required: true, placeholder: 'e.g. Senior React Developer' }),
    job_description: h('textarea', { rows: 7, placeholder: 'Paste the job description or summary…' }),
  };
  const defaultTypes = ['Full-time', 'Part-time', 'Contract', 'Freelance', 'Internship', 'Remote'];
  const types = [...new Set([...meta.job_types, ...defaultTypes])];

  const people = [];
  const peopleWrap = h('div', { class: 'stack' });
  const addPerson = () => {
    const cf = contactFormFields();
    const chat = chatPasteField();
    const item = { cf, chat };
    const el = h('div', { class: 'person-editor stack' },
      h('button', { type: 'button', class: 'btn ghost xs remove', onclick: () => { el.remove(); people.splice(people.indexOf(item), 1); } }, '✕ Remove'),
      h('b', null, 'Person contacted'), cf.grid, chat.el);
    item.el = el;
    people.push(item);
    peopleWrap.append(el);
    cf.f.name.focus();
  };

  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Submit job');
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      try {
        const payload = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        const { id } = await POST('/api/jobs', payload);
        let failed = 0;
        for (const p of people) {
          const v = p.cf.values();
          if (!v.name.trim()) continue;
          try { await POST(`/api/jobs/${id}/contacts`, { ...v, messages: parseChat(p.chat.ta.value, v.name) }); }
          catch { failed++; }
        }
        clear(result).append(h('div', { class: `notice ${failed ? 'warn' : 'ok'}`, style: { marginBottom: '16px' } },
          h('b', null, failed ? `Job submitted, but ${failed} person record(s) failed to save. ` : 'Job submitted! '),
          h('a', { href: `#/jobs?open=${id}` }, 'Open it in job logs'), ' to add more people or chat history.'));
        form.reset();
        f.name.value = S.me.username;
        clear(peopleWrap); people.length = 0;
        ok('Job submitted');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) { fail(err); }
      finally { submitBtn.disabled = false; }
    },
  },
  h('div', { class: 'card-head' }, h('h2', null, 'Job details')),
  h('div', { class: 'card-pad' }, h('div', { class: 'form-grid' },
    field('Name', f.name, '— your username'), field('Crag username', f.crag_username, '— optional'),
    field('Location', f.location), field('Job type', f.job_type),
    h('div', { class: 'full' }, field('Job title *', f.job_title)),
    h('div', { class: 'full' }, field('Job description', f.job_description)),
    h('datalist', { id: 'dl-locations' }, meta.locations.map((l) => h('option', { value: l }))),
    h('datalist', { id: 'dl-jobtypes' }, types.map((t) => h('option', { value: t }))))),
  h('div', { class: 'card-head', style: { borderTop: '1px solid var(--border)' } },
    h('div', null, h('h2', null, 'People contacted via this job'), h('div', { class: 'small muted' }, 'Optional — you can also add them later from the job logs.')),
    h('button', { type: 'button', class: 'btn sm', onclick: addPerson }, '＋ Add person')),
  h('div', { class: 'card-pad' }, peopleWrap),
  h('div', { class: 'modal-foot' }, h('a', { class: 'btn', href: '#/jobs?view=mine' }, 'My job logs'), submitBtn));

  root.append(result, form);
  f.job_title.focus();
}

/* ------------------------------------------------------------------ */
/* Job logs                                                            */
/* ------------------------------------------------------------------ */

async function pageJobs(root, params, alive) {
  const scope = S.me.effective_scope;
  const st = {
    view: params.get('view') || '', q: params.get('q') || '', group: params.get('group') || '',
    user_id: params.get('user_id') || '', job_type: params.get('job_type') || '',
    date_from: params.get('date_from') || '', date_to: params.get('date_to') || '',
    sort: params.get('sort') || 'created_at', dir: params.get('dir') || 'desc', page: Number(params.get('page') || 1),
  };
  const expanded = new Set();
  if (params.get('open')) expanded.add(Number(params.get('open')));
  const openContacts = new Set();

  const meta = await GET('/api/meta');
  if (!alive()) return;

  const subtitle = {
    own: 'Your submitted jobs. Click a row to see the people contacted and their chat history.',
    group: `Jobs from group ${S.me.group_number}. Click a row to expand.`,
    all: 'All submitted jobs. Click a row to expand.',
  }[scope];
  const exportBtn = (isAdmin() || isLeader()) ? h('button', { class: 'btn', onclick: () => { window.location = `/api/jobs/export.csv?${queryString(false)}`; } }, '⬇ Export CSV') : null;
  root.append(pageHead('Job logs', subtitle, exportBtn, h('a', { class: 'btn primary', href: '#/submit' }, '＋ Submit job')));

  // ----- toolbar
  const search = h('input', { type: 'search', placeholder: 'Search title, name, location, people…', value: st.q });
  search.addEventListener('input', debounce(() => { st.q = search.value; st.page = 1; load(); }, 300));
  const toolbar = h('div', { class: 'toolbar' }, search);

  if (scope !== 'own' && !isAdmin()) {
    const opts = [['', scope === 'all' ? 'All' : 'My group'], ['mine', 'Mine']];
    if (scope === 'all' && S.me.group_number != null) opts.splice(1, 0, ['group', 'My group']);
    const wrap = h('span');
    const drawSeg = () => clear(wrap).append(seg(opts, st.view, (v) => { st.view = v; st.page = 1; drawSeg(); load(); }));
    drawSeg();
    toolbar.append(wrap);
  }
  let userSel = null;
  if (scope !== 'own') {
    if (meta.groups.length > 1 || isAdmin()) {
      toolbar.append(select([['', 'All groups'], ...meta.groups.map((g) => [g.number, groupLabel(g.number, g.name)])], st.group, {
        onchange: (e) => { st.group = e.target.value; st.user_id = ''; st.page = 1; drawUsers(); load(); },
      }));
    }
    userSel = h('span');
    toolbar.append(userSel);
  }
  function drawUsers() {
    if (!userSel) return;
    const list = meta.users.filter((u) => !st.group || String(u.group_number) === String(st.group));
    clear(userSel).append(select([['', 'All members'], ...list.map((u) => [u.id, u.username])], st.user_id, {
      onchange: (e) => { st.user_id = e.target.value; st.page = 1; load(); },
    }));
  }
  drawUsers();
  if (meta.job_types.length) {
    toolbar.append(select([['', 'All job types'], ...meta.job_types.map((t) => [t, t])], st.job_type, {
      onchange: (e) => { st.job_type = e.target.value; st.page = 1; load(); },
    }));
  }
  const df = h('input', { type: 'date', value: st.date_from, title: 'From date', onchange: (e) => { st.date_from = e.target.value; st.page = 1; load(); } });
  const dt = h('input', { type: 'date', value: st.date_to, title: 'To date', onchange: (e) => { st.date_to = e.target.value; st.page = 1; load(); } });
  toolbar.append(h('span', { class: 'row', style: { gap: '4px' } }, df, h('span', { class: 'muted' }, '–'), dt));
  toolbar.append(h('button', { class: 'btn ghost sm', onclick: () => setHashParams('/jobs', {}, false) }, 'Clear filters'));

  const summary = h('div', { class: 'summary-strip' });
  const tableWrap = h('div', { class: 'table-wrap' });
  const pager = h('div', { class: 'pager' });
  root.append(h('div', { class: 'card' }, toolbar, summary, tableWrap, pager));

  const showGroupCol = scope !== 'own';
  const cols = [
    ['', null], ['Submitted', 'created_at'], ['Name', 'name'], showGroupCol ? ['Group', null] : null,
    ['Crag username', 'crag_username'], ['Location', 'location'], ['Job type', 'job_type'], ['Job title', 'job_title'],
    ['People', 'contact_count'], ['Msgs', null], ['Last activity', 'last_activity'],
  ].filter(Boolean);

  function queryString(withPaging = true) {
    const q = new URLSearchParams();
    for (const k of ['view', 'q', 'group', 'user_id', 'job_type']) if (st[k]) q.set(k, st[k]);
    if (st.date_from) q.set('date_from', localDayBound(st.date_from, false));
    if (st.date_to) q.set('date_to', localDayBound(st.date_to, true));
    if (withPaging) { q.set('sort', st.sort); q.set('dir', st.dir); q.set('page', st.page); q.set('per_page', 25); }
    return q.toString();
  }

  function rowEl(job) {
    const open = expanded.has(job.id);
    const tr = h('tr', { class: `job-row ${open ? 'open' : ''}`, 'data-id': job.id, onclick: () => toggle(job.id) },
      h('td', { style: { width: '24px' } }, h('span', { class: 'chev' }, '▶')),
      h('td', { class: 'nowrap', title: fmtDateTime(job.created_at) }, fmtDate(job.created_at)),
      h('td', { class: 'nowrap' }, h('b', null, job.name || job.username)),
      showGroupCol ? h('td', null, job.group_number != null ? h('span', { class: 'badge' }, `G${job.group_number}`) : '—') : null,
      h('td', { class: 'ellipsis', title: job.crag_username }, job.crag_username || h('span', { class: 'faint' }, '—')),
      h('td', { class: 'ellipsis', title: job.location }, job.location || h('span', { class: 'faint' }, '—')),
      h('td', { class: 'nowrap' }, job.job_type || h('span', { class: 'faint' }, '—')),
      h('td', { class: 'title-cell ellipsis', title: job.job_title }, job.job_title),
      h('td', { class: 'nowrap' }, h('span', { class: `badge people-pill ${job.contact_count ? 'blue' : 'zero'}`, title: `${job.contact_count} people contacted, ${job.success_count} successful` },
        '👤 ', job.contact_count), job.success_count ? h('span', { class: 'badge green', style: { marginLeft: '4px' }, title: 'Successful' }, '✓ ', job.success_count) : null),
      h('td', { class: 'num muted' }, job.message_count),
      h('td', { class: 'nowrap muted', title: fmtDateTime(job.last_activity) }, fmtRel(job.last_activity)));
    return tr;
  }

  function detailRowEl(jobId) {
    const holder = h('div', null, loading('Loading details…'));
    const tr = h('tr', { class: 'detail-row', 'data-detail': jobId }, h('td', { colspan: cols.length }, holder));
    loadDetail(jobId, holder);
    return tr;
  }

  async function loadDetail(jobId, holder) {
    try {
      const { job } = await GET(`/api/jobs/${jobId}`);
      clear(holder).append(renderJobDetail(job, {
        openContacts,
        refresh: () => refreshJob(jobId),
        removed: () => { expanded.delete(jobId); load(); },
      }));
      // keep summary row in sync
      const row = tableWrap.querySelector(`tr.job-row[data-id="${jobId}"]`);
      if (row) row.replaceWith(rowEl(job));
    } catch (e) {
      clear(holder).append(h('div', { class: 'notice error' }, e.message));
    }
  }
  function refreshJob(jobId) {
    const dr = tableWrap.querySelector(`tr[data-detail="${jobId}"]`);
    if (dr) return loadDetail(jobId, dr.querySelector('td').firstChild);
  }

  function toggle(id) {
    const row = tableWrap.querySelector(`tr.job-row[data-id="${id}"]`);
    if (expanded.has(id)) {
      expanded.delete(id);
      row.classList.remove('open');
      const dr = tableWrap.querySelector(`tr[data-detail="${id}"]`);
      if (dr) dr.remove();
    } else {
      expanded.add(id);
      row.classList.add('open');
      row.after(detailRowEl(id));
    }
  }

  async function load() {
    setHashParams('/jobs', { view: st.view, q: st.q, group: st.group, user_id: st.user_id, job_type: st.job_type,
      date_from: st.date_from, date_to: st.date_to, sort: st.sort !== 'created_at' ? st.sort : '', dir: st.dir !== 'desc' ? st.dir : '', page: st.page > 1 ? st.page : '' });
    if (!tableWrap.firstChild) tableWrap.append(loading());
    let data;
    try { data = await GET(`/api/jobs?${queryString()}`); }
    catch (e) { clear(tableWrap).append(h('div', { class: 'notice error', style: { margin: '16px' } }, e.message)); return; }
    if (!alive()) return;

    clear(summary).append(
      h('span', null, h('b', null, fmtNum(data.total)), ' jobs'),
      h('span', null, h('b', null, fmtNum(data.total_contacts)), ' people contacted'),
      h('span', null, h('b', null, fmtNum(data.total_successes)), ' successful'),
      data.total ? h('span', null, h('b', null, (data.total_contacts / data.total).toFixed(1)), ' people / job') : null);

    if (!data.jobs.length) {
      clear(tableWrap).append(emptyState('📭', 'No jobs found', st.q || st.group || st.user_id || st.job_type || st.date_from || st.date_to
        ? 'Try changing the filters.' : h('a', { href: '#/submit' }, 'Submit your first job')));
      clear(pager);
      return;
    }
    const thead = h('thead', null, h('tr', null, cols.map(([label, key]) => {
      if (!key) return h('th', null, label);
      const active = st.sort === key;
      return h('th', {
        class: 'sortable', onclick: () => {
          if (active) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = key; st.dir = key === 'created_at' || key === 'contact_count' || key === 'last_activity' ? 'desc' : 'asc'; }
          load();
        },
      }, label, active ? h('span', { class: 'arrow' }, st.dir === 'asc' ? '▲' : '▼') : null);
    })));
    const tbody = h('tbody');
    for (const job of data.jobs) {
      tbody.append(rowEl(job));
      if (expanded.has(job.id)) tbody.append(detailRowEl(job.id));
    }
    clear(tableWrap).append(h('table', null, thead, tbody));

    const pages = Math.max(1, Math.ceil(data.total / data.per_page));
    const from = (data.page - 1) * data.per_page + 1;
    clear(pager).append(
      h('span', null, `${from}–${Math.min(data.total, data.page * data.per_page)} of ${data.total}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', disabled: data.page <= 1, onclick: () => { st.page--; load(); } }, '← Prev'),
        h('span', null, `Page ${data.page} / ${pages}`),
        h('button', { class: 'btn sm', disabled: data.page >= pages, onclick: () => { st.page++; load(); } }, 'Next →')));
  }

  await load();
  if (params.get('open')) {
    const dr = tableWrap.querySelector(`tr[data-detail="${params.get('open')}"]`);
    if (dr) setTimeout(() => dr.previousSibling.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

function renderJobDetail(job, ctx) {
  const can = job.can_edit;
  const metaItem = (k, v) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v || h('span', { class: 'faint' }, '—')));

  const addHolder = h('div');
  const showAddForm = () => {
    if (addHolder.firstChild) { addHolder.querySelector('input').focus(); return; }
    const cf = contactFormFields();
    const chat = chatPasteField();
    const saveBtn = h('button', { class: 'btn primary sm', type: 'submit' }, 'Save person');
    const form = h('form', {
      class: 'person-editor stack',
      onsubmit: async (e) => {
        e.preventDefault(); saveBtn.disabled = true;
        try {
          const v = cf.values();
          const { id } = await POST(`/api/jobs/${job.id}/contacts`, { ...v, messages: parseChat(chat.ta.value, v.name) });
          ctx.openContacts.add(id);
          ok('Person added');
          ctx.refresh();
        } catch (err) { fail(err); saveBtn.disabled = false; }
      },
    },
    h('b', null, 'Add person contacted via this job'), cf.grid, chat.el,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { class: 'btn sm', type: 'button', onclick: () => clear(addHolder) }, 'Cancel'), saveBtn));
    addHolder.append(form);
    cf.f.name.focus();
  };

  const contacts = h('div', { class: 'contacts' });
  if (!job.contacts.length) {
    contacts.append(h('div', { class: 'muted small', style: { padding: '6px 2px' } },
      can ? 'No people logged yet. Use “Add person” to record who you contacted through this job.' : 'No people logged for this job.'));
  }
  for (const c of job.contacts) contacts.append(renderContact(c, job, ctx));

  return h('div', { class: 'detail', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
      h('div', { style: { minWidth: 0, flex: 1 } }, h('h3', null, job.job_title)),
      can ? h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => editJobModal(job, ctx.refresh) }, '✎ Edit job'),
        h('button', {
          class: 'btn sm danger', onclick: async () => {
            if (!(await confirmDialog(`Delete "${job.job_title}" and its ${job.contact_count} contacted people with all chat history? This cannot be undone.`, { okLabel: 'Delete job', danger: true }))) return;
            try { await DEL(`/api/jobs/${job.id}`); ok('Job deleted'); ctx.removed(); } catch (e) { fail(e); }
          },
        }, 'Delete')) : null),
    h('div', { class: 'detail-meta' },
      metaItem('Name', job.name || job.username), metaItem('Crag username', job.crag_username),
      metaItem('Group', job.group_number != null ? `Group ${job.group_number}` : ''),
      metaItem('Location', job.location), metaItem('Job type', job.job_type),
      metaItem('Submitted', fmtDateTime(job.created_at)), metaItem('Last updated', fmtDateTime(job.updated_at))),
    job.job_description ? h('div', null, h('div', { class: 'small muted', style: { marginBottom: '4px' } }, 'Job description'),
      h('div', { class: 'desc pre' }, job.job_description)) : null,
    h('div', { class: 'people-head' },
      h('h3', null, `People contacted (${job.contacts.length})`,
        job.success_count ? h('span', { class: 'badge green', style: { marginLeft: '8px' } }, `${job.success_count} successful`) : null),
      can ? h('button', { class: 'btn primary sm', onclick: showAddForm }, '＋ Add person') : null),
    addHolder,
    contacts);
}

function renderContact(c, job, ctx) {
  const can = job.can_edit;
  const open = ctx.openContacts.has(c.id);
  const last = c.messages[c.messages.length - 1];
  const card = h('div', { class: `contact ${open ? 'open' : ''}` });
  const body = h('div', { class: 'contact-body' });

  const statusEl = can
    ? select(Object.entries(STATUS).map(([k, v]) => [k, v.label]), c.status, {
      class: 'compact', onclick: (e) => e.stopPropagation(),
      onchange: async (e) => {
        try { await PUT(`/api/contacts/${c.id}`, { ...c, status: e.target.value }); ok('Status updated'); ctx.refresh(); }
        catch (err) { fail(err); }
      },
    })
    : statusBadge(c.status);

  const head = h('div', {
    class: 'contact-head',
    onclick: () => {
      if (ctx.openContacts.has(c.id)) ctx.openContacts.delete(c.id); else ctx.openContacts.add(c.id);
      card.classList.toggle('open');
      body.classList.toggle('hidden');
      if (!body.classList.contains('hidden')) { const chat = body.querySelector('.chat'); if (chat) chat.scrollTop = chat.scrollHeight; }
    },
  },
  h('div', { class: 'avatar alt' }, initials(c.name)),
  h('div', { class: 'who' }, h('b', null, c.name),
    h('span', { class: 'small muted' }, [c.contact_info, c.platform].filter(Boolean).join(' · ') || 'No contact info')),
  statusEl,
  h('div', { class: 'preview' }, last ? `${last.sender === 'me' ? 'You: ' : ''}${last.content.split('\n')[0]}` : h('span', { class: 'faint' }, 'No chat history yet')),
  h('span', { class: `badge ${c.message_count ? '' : 'zero'}`, title: 'Messages' }, '💬 ', c.message_count),
  last ? h('span', { class: 'small faint nowrap' }, fmtRel(last.sent_at)) : null,
  can ? h('div', { class: 'row', onclick: (e) => e.stopPropagation() },
    h('button', { class: 'btn ghost xs', title: 'Edit person', onclick: () => editContactModal(c, ctx.refresh) }, '✎'),
    h('button', {
      class: 'btn ghost xs', title: 'Delete person', style: { color: 'var(--danger)' },
      onclick: async () => {
        if (!(await confirmDialog(`Delete ${c.name} and ${c.message_count} chat messages?`, { okLabel: 'Delete', danger: true }))) return;
        try { await DEL(`/api/contacts/${c.id}`); ok('Person deleted'); ctx.refresh(); } catch (e) { fail(e); }
      },
    }, '🗑')) : null);

  if (!open) body.classList.add('hidden');
  if (c.notes) body.append(h('div', { class: 'notes pre' }, c.notes));

  const chat = h('div', { class: 'chat' });
  if (!c.messages.length) chat.append(h('div', { class: 'muted small', style: { textAlign: 'center', padding: '10px' } }, 'No messages yet.'));
  for (const m of c.messages) {
    chat.append(h('div', { class: `msg ${m.sender === 'me' ? 'me' : 'them'}` },
      h('div', { class: 'bubble' }, m.content),
      h('div', { class: 'meta' }, m.sender === 'me' ? job.username : c.name, ' · ', fmtDateTime(m.sent_at),
        can ? h('button', {
          class: 'del', title: 'Delete message',
          onclick: async () => {
            if (!(await confirmDialog('Delete this message?', { okLabel: 'Delete', danger: true }))) return;
            try { await DEL(`/api/messages/${m.id}`); ctx.refresh(); } catch (e) { fail(e); }
          },
        }, 'delete') : null)));
  }
  body.append(chat);

  if (can) {
    const sender = select([['me', `Me (${job.username})`], ['contact', c.name]], 'me', { class: 'compact' });
    const ta = h('textarea', { rows: 1, placeholder: 'Type a message to log…  (Ctrl+Enter to add)' });
    const when = h('input', { type: 'datetime-local', class: 'compact', title: 'Message time (leave empty for now)' });
    const send = async () => {
      if (!ta.value.trim()) return;
      try {
        await POST(`/api/contacts/${c.id}/messages`, { sender: sender.value, content: ta.value, sent_at: when.value ? new Date(when.value).toISOString() : '' });
        ctx.refresh();
      } catch (e) { fail(e); }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    body.append(h('div', { class: 'composer' }, sender, ta, h('button', { class: 'btn primary', onclick: send }, 'Add')),
      h('div', { class: 'row small muted' }, 'Time:', when, h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => pasteChatModal(c, ctx.refresh) }, '📋 Paste conversation')));
  }
  card.append(head, body);
  if (open) setTimeout(() => { chat.scrollTop = chat.scrollHeight; }, 0);
  return card;
}

function editJobModal(job, after) {
  const f = {
    name: h('input', { type: 'text', value: job.name, readOnly: true }),
    crag_username: h('input', { type: 'text', value: job.crag_username, placeholder: 'Optional' }),
    location: h('input', { type: 'text', value: job.location }),
    job_type: h('input', { type: 'text', value: job.job_type }),
    job_title: h('input', { type: 'text', value: job.job_title }),
    job_description: h('textarea', { rows: 8 }, job.job_description),
  };
  modal({
    title: 'Edit job', wide: true,
    body: h('div', { class: 'form-grid' },
      field('Name', f.name), field('Crag username', f.crag_username, '— optional'), field('Location', f.location), field('Job type', f.job_type),
      h('div', { class: 'full' }, field('Job title *', f.job_title)), h('div', { class: 'full' }, field('Job description', f.job_description))),
    actions: [{ label: 'Cancel' }, {
      label: 'Save changes', class: 'primary', onClick: async () => {
        await PUT(`/api/jobs/${job.id}`, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
        ok('Job updated'); after();
      },
    }],
  });
}

function editContactModal(c, after) {
  const cf = contactFormFields(c);
  modal({
    title: `Edit ${c.name}`, wide: true, body: cf.grid,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', class: 'primary', onClick: async () => { await PUT(`/api/contacts/${c.id}`, cf.values()); ok('Saved'); after(); },
    }],
  });
}

function pasteChatModal(c, after) {
  const ta = h('textarea', { rows: 10, placeholder: `Me: Hello ${c.name}…\n${c.name.split(' ')[0]}: Hi! …` });
  const prev = h('div', { class: 'small muted' }, 'Nothing parsed yet.');
  ta.addEventListener('input', () => {
    const msgs = parseChat(ta.value, c.name);
    const mine = msgs.filter((m) => m.sender === 'me').length;
    prev.textContent = msgs.length ? `${msgs.length} messages detected (${mine} from you, ${msgs.length - mine} from ${c.name}).` : 'Nothing parsed yet.';
  });
  modal({
    title: `Paste conversation with ${c.name}`, wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'notice info' }, 'One message per line starting with "Me:" or "Them:" (the person\'s name also works). Lines without a prefix are joined to the previous message. Messages are logged with the current time, in order.'),
      ta, prev),
    actions: [{ label: 'Cancel' }, {
      label: 'Add messages', class: 'primary', onClick: async () => {
        const msgs = parseChat(ta.value, c.name);
        if (!msgs.length) { toast('No messages detected', 'error'); return false; }
        const base = Date.now() - msgs.length * 1000;
        await POST(`/api/contacts/${c.id}/messages`, { messages: msgs.map((m, i) => ({ ...m, sent_at: new Date(base + i * 1000).toISOString() })) });
        ok(`${msgs.length} messages added`); after();
      },
    }],
  });
}

/* ------------------------------------------------------------------ */
/* Competition                                                         */
/* ------------------------------------------------------------------ */

async function pageCompetition(root, params, alive) {
  const days = params.has('days') ? Number(params.get('days')) : 7;
  const metric = params.get('by') || 'points';
  const go = (p) => setHashParams('/competition', { days, by: metric, ...p }, false);
  root.append(pageHead('Group competition', `Ranking for ${periodText(days)}`,
    seg([['points', 'Total points'], ['points_per_member', 'Points per member']], metric, (v) => go({ by: v })),
    periodPicker(days, (d) => go({ days: d }))));
  const body = h('div', null, loading());
  root.append(body);
  const data = await GET(`/api/stats/competition?days=${days}`);
  if (!alive()) return;
  clear(body);

  const groups = [...data.groups].sort((a, b) => b[metric] - a[metric] || b.jobs - a.jobs);
  const max = Math.max(1, ...groups.map((g) => g[metric]));
  const myGroup = S.me.group_number;

  if (groups.length >= 1) {
    const podium = h('div', { class: 'stats' });
    groups.slice(0, 3).forEach((g, i) => podium.append(h('div', { class: `stat ${i === 0 ? 'accent' : ''}` },
      h('div', { class: 'label' }, ['🥇 1st place', '🥈 2nd place', '🥉 3rd place'][i]),
      h('div', { class: 'value' }, groupLabel(g.number, g.name)),
      h('div', { class: 'sub' }, `${fmtNum(g[metric])} ${metric === 'points' ? 'points' : 'pts / member'} · ${g.jobs} jobs · ${g.contacts} people`))));
    body.append(podium);
  }

  body.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('h2', null, 'Leaderboard'), h('span', { class: 'small muted' }, pointsText(data.points))),
    groups.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Rank'), h('th', null, 'Group'), h('th', null, 'Leader(s)'),
        h('th', { class: 'num' }, 'Members'), h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num' }, 'People'),
        h('th', { class: 'num' }, 'Successful'), h('th', { class: 'num' }, 'Points'), h('th', { class: 'num' }, 'Per member'), h('th', { style: { width: '22%' } }))),
      h('tbody', null, groups.map((g, i) => h('tr', { class: g.number === myGroup ? 'me-row' : '' },
        h('td', null, h('div', { class: `rank ${i < 3 ? 'r' + (i + 1) : ''}` }, i + 1)),
        h('td', null, h('b', null, groupLabel(g.number, g.name)), g.number === myGroup ? h('span', { class: 'badge blue', style: { marginLeft: '6px' } }, 'Your group') : null),
        h('td', { class: 'muted' }, g.leaders || '—'),
        h('td', { class: 'num' }, g.members), h('td', { class: 'num' }, g.jobs), h('td', { class: 'num' }, g.contacts),
        h('td', { class: 'num' }, g.successes), h('td', { class: 'num' }, h('b', null, fmtNum(g.points))),
        h('td', { class: 'num' }, fmtNum(g.points_per_member)),
        h('td', null, h('div', { class: 'meter' }, h('span', { style: { width: `${(g[metric] / max) * 100}%` } })))))))) :
      emptyState('🏁', 'No activity yet', 'Rankings appear once members start submitting jobs.')));

  body.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Top performers')),
    data.top_members.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Member'), h('th', null, 'Group'),
        h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num' }, 'People'), h('th', { class: 'num' }, 'Successful'), h('th', { class: 'num' }, 'Points'))),
      h('tbody', null, data.top_members.map((m, i) => h('tr', { class: m.id === S.me.id ? 'me-row' : '' },
        h('td', null, h('div', { class: `rank ${i < 3 ? 'r' + (i + 1) : ''}` }, i + 1)),
        h('td', null, h('b', null, m.username)),
        h('td', null, m.group_number != null ? h('span', { class: 'badge' }, `Group ${m.group_number}`) : '—'),
        h('td', { class: 'num' }, m.jobs), h('td', { class: 'num' }, m.contacts), h('td', { class: 'num' }, m.successes),
        h('td', { class: 'num' }, h('b', null, fmtNum(m.points)))))))) :
      emptyState('⭐', 'No points scored in this period')));
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

async function pageProfile(root) {
  root.append(pageHead('My profile', `${S.me.username} · ${ROLE_LABEL[S.me.role]}${S.me.group_number != null ? ` · Group ${S.me.group_number}` : ''}`));
  const cur =h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  root.append(h('div', { class: 'two-col' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Account')),
      h('div', { class: 'card-pad stack' },
        field('Username', h('input', { type: 'text', value: S.me.username, readOnly: true })),
        h('div', { class: 'notice info' }, 'You can see: ', h('b', null, SCOPE_LABEL[S.me.effective_scope]), '. Only an administrator can change this.'))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Change password')),
      h('form', {
        class: 'card-pad stack', onsubmit: async (e) => {
          e.preventDefault();
          if (n1.value !== n2.value) return fail('New passwords do not match');
          try { await POST('/api/auth/password', { current_password: cur.value, new_password: n1.value }); e.target.reset(); ok('Password changed'); }
          catch (err) { fail(err); }
        },
      }, field('Current password', cur), field('New password', n1, '— at least 6 characters'), field('Confirm new password', n2),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Change password'))))));
}

/* ------------------------------------------------------------------ */
/* Admin: users                                                        */
/* ------------------------------------------------------------------ */

async function pageAdminUsers(root, params, alive) {
  const st = { q: '', group: params.get('group') || '', role: '', status: '' };
  const selected = new Set();
  let users = [];
  let groups = [];

  root.append(pageHead('Users', 'Approve sign-ups, assign roles and groups, and control who can see which logs.',
    h('button', { class: 'btn primary', onclick: () => addUserModal(reload) }, '＋ Add user')));
  const pendingBox = h('div');
  const bulkBox = h('div', { class: 'card card-pad', style: { marginBottom: '16px' } });
  const listCard = h('div', { class: 'card' });
  root.append(pendingBox, bulkBox, listCard);

  const search = h('input', { type: 'search', placeholder: 'Search users…' });
  search.addEventListener('input', debounce(() => { st.q = search.value.toLowerCase(); drawList(); }, 200));
  const groupSel = h('span');
  const toolbar = h('div', { class: 'toolbar' }, search, groupSel,
    select([['', 'All roles'], ['member', 'Members'], ['leader', 'Group leaders'], ['admin', 'Administrators']], '', { onchange: (e) => { st.role = e.target.value; drawList(); } }),
    select([['', 'Any status'], ['active', 'Active'], ['disabled', 'Disabled / pending']], '', { onchange: (e) => { st.status = e.target.value; drawList(); } }));
  const tableWrap = h('div', { class: 'table-wrap' });
  listCard.append(toolbar, tableWrap);

  async function reload() {
    const [u, g] = await Promise.all([GET('/api/admin/users'), GET('/api/admin/groups')]);
    if (!alive()) return;
    users = u.users; groups = g.groups;
    for (const id of [...selected]) if (!users.find((x) => x.id === id)) selected.delete(id);
    clear(groupSel).append(select([['', 'All groups'], ...groups.map((x) => [x.number, groupLabel(x.number, x.name)])], st.group,
      { onchange: (e) => { st.group = e.target.value; drawList(); } }));
    drawPending(); drawBulk(); drawList();
    refreshPending();
  }

  async function update(u, patch, msg = 'Saved') {
    try { await PUT(`/api/admin/users/${u.id}`, patch); ok(msg); }
    catch (e) { fail(e); }
    await reload();
    if (u.id === S.me.id) { const r = await GET('/api/auth/me'); S.me = r.user; }
  }

  function drawPending() {
    const pending = users.filter((u) => !u.active && !u.last_login);
    clear(pendingBox);
    if (!pending.length) return;
    pendingBox.append(h('div', { class: 'card', style: { marginBottom: '16px', borderColor: '#f3d48a' } },
      h('div', { class: 'card-head', style: { background: 'var(--warn-weak)' } }, h('h2', null, `Waiting for approval (${pending.length})`),
        h('button', {
          class: 'btn sm primary', onclick: async () => {
            try { await POST('/api/admin/users/bulk', { target: 'ids', ids: pending.map((p) => p.id), active: true }); ok('All approved'); } catch (e) { fail(e); }
            reload();
          },
        }, 'Approve all')),
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, pending.map((u) => h('tr', null,
        h('td', null, h('b', null, u.username)),
        h('td', null, `Group ${u.group_number}`),
        h('td', { class: 'muted' }, `Signed up ${fmtRel(u.created_at)}`),
        h('td', { style: { textAlign: 'right' } }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn sm primary', onclick: () => update(u, { active: true }, `${u.username} approved`) }, 'Approve'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              if (!(await confirmDialog(`Reject and delete the sign-up for ${u.username}?`, { okLabel: 'Reject', danger: true }))) return;
              try { await DEL(`/api/admin/users/${u.id}`); ok('Rejected'); } catch (e) { fail(e); }
              reload();
            },
          }, 'Reject'))))))))));
  }

  function drawBulk() {
    const target = select([
      ['all', 'All members & leaders'],
      ...groups.map((g) => [`g:${g.number}`, `Everyone in ${groupLabel(g.number, g.name)}`]),
      ['ids', `Selected users (${selected.size})`],
    ], selected.size ? 'ids' : 'all', { class: 'compact' });
    const scope = select(Object.entries(SCOPE_LABEL), 'own', { class: 'compact' });
    const targetPayload = () => {
      const v = target.value;
      if (v === 'all') return { target: 'all' };
      if (v === 'ids') return { target: 'ids', ids: [...selected] };
      return { target: 'group', group: Number(v.slice(2)) };
    };
    const run = async (patch, label) => {
      const t = targetPayload();
      if (t.target === 'ids' && !t.ids.length) return fail('Select users in the table first');
      try { const r = await POST('/api/admin/users/bulk', { ...t, ...patch }); ok(`${label}: ${r.updated} users updated`); } catch (e) { fail(e); }
      reload();
    };
    clear(bulkBox).append(
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('div', null, h('h3', null, 'Log visibility & bulk actions'),
          h('div', { class: 'small muted' }, 'Decide whether users see only their own logs, their group\'s logs, or every log. Group leaders always see at least their group. Administrators always see everything.')),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Apply to'), target,
          h('button', { class: 'btn sm', onclick: () => run({ view_scope: scope.value }, 'Visibility') }, 'Set visibility →'), scope,
          h('span', { class: 'muted' }, '|'),
          h('button', { class: 'btn sm', onclick: () => run({ active: true }, 'Enabled') }, 'Enable'),
          h('button', { class: 'btn sm danger', onclick: () => run({ active: false }, 'Disabled') }, 'Disable'))));
  }

  function drawList() {
    const list = users.filter((u) => {
      if (st.q && !u.username.toLowerCase().includes(st.q)) return false;
      if (st.group && String(u.group_number) !== st.group) return false;
      if (st.role && u.role !== st.role) return false;
      if (st.status === 'active' && !u.active) return false;
      if (st.status === 'disabled' && u.active) return false;
      return true;
    });
    if (!list.length) { clear(tableWrap).append(emptyState('👤', 'No users match')); return; }
    const allSel = list.every((u) => selected.has(u.id));
    const selAll = h('input', {
      type: 'checkbox', checked: allSel && list.length > 0,
      onchange: (e) => { for (const u of list) { if (e.target.checked) selected.add(u.id); else selected.delete(u.id); } drawBulk(); drawList(); },
    });
    clear(tableWrap).append(h('table', null,
      h('thead', null, h('tr', null, h('th', null, selAll), h('th', null, 'User'), h('th', null, 'Group'), h('th', null, 'Role'),
        h('th', null, 'Can see'), h('th', null, 'Active'), h('th', { class: 'num' }, 'Jobs'), h('th', null, 'Last sign-in'), h('th'))),
      h('tbody', null, list.map((u) => {
        const groupIn = h('input', {
          type: 'number', class: 'compact', style: { width: '70px' }, value: u.group_number ?? '', placeholder: '—',
          onchange: (e) => update(u, { group_number: e.target.value }, 'Group changed'),
        });
        return h('tr', { style: u.active ? null : { opacity: 0.7 } },
          h('td', null, h('input', {
            type: 'checkbox', checked: selected.has(u.id),
            onchange: (e) => { if (e.target.checked) selected.add(u.id); else selected.delete(u.id); drawBulk(); },
          })),
          h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
            h('div', { class: 'avatar alt' }, initials(u.username)),
            h('div', null, h('b', null, u.username), u.id === S.me.id ? h('span', { class: 'badge blue', style: { marginLeft: '6px' } }, 'You') : null))),
          h('td', null, groupIn),
          h('td', null, select(Object.entries(ROLE_LABEL), u.role, { class: 'compact', onchange: (e) => update(u, { role: e.target.value }, 'Role changed') })),
          h('td', null, u.role === 'admin' ? h('span', { class: 'badge blue' }, 'Everything')
            : select(Object.entries(SCOPE_LABEL).map(([k, l]) => [k, u.role === 'leader' && k === 'own' ? "Own group's logs (leader)" : l]),
              u.role === 'leader' && u.view_scope === 'own' ? 'own' : u.view_scope,
              { class: 'compact', onchange: (e) => update(u, { view_scope: e.target.value }, 'Visibility changed') })),
          h('td', null, switchEl(u.active, (v) => update(u, { active: v }, v ? 'Enabled' : 'Disabled'))),
          h('td', { class: 'num' }, u.job_count),
          h('td', { class: 'muted nowrap' }, u.last_login ? fmtRel(u.last_login) : (u.active ? 'never' : h('span', { class: 'badge amber' }, 'pending'))),
          h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } },
            h('a', { class: 'btn xs', href: `#/jobs?user_id=${u.id}` }, 'Logs'),
            h('button', { class: 'btn xs', onclick: () => resetPasswordModal(u) }, 'Reset password'),
            u.id !== S.me.id ? h('button', {
              class: 'btn xs danger', onclick: async () => {
                if (!(await confirmDialog(`Delete ${u.username}? This also deletes their ${u.job_count} job(s), people and chat history. Consider disabling instead.`, { okLabel: 'Delete user', danger: true }))) return;
                try { await DEL(`/api/admin/users/${u.id}`); ok('User deleted'); } catch (e) { fail(e); }
                reload();
              },
            }, 'Delete') : null)));
      }))));
  }

  await reload();
}

function addUserModal(after) {
  const u = h('input', { type: 'text', placeholder: '3-ALEX' });
  const p = h('input', { type: 'text', value: Math.random().toString(36).slice(2, 10) });
  const role = select(Object.entries(ROLE_LABEL), 'member');
  const scope = select(Object.entries(SCOPE_LABEL), 'own');
  modal({
    title: 'Add user',
    body: h('div', { class: 'form-grid' },
      h('div', { class: 'full' }, field('Username *', u, '— 3-XXX joins group 3')),
      field('Role', role), field('Can see', scope),
      h('div', { class: 'full' }, field('Initial password *', p, '— share it with the user; they can change it in their profile'))),
    actions: [{ label: 'Cancel' }, {
      label: 'Create user', class: 'primary', onClick: async () => {
        await POST('/api/admin/users', { username: u.value, password: p.value, role: role.value, view_scope: scope.value });
        ok('User created'); after();
      },
    }],
  });
}

function resetPasswordModal(u) {
  const p = h('input', { type: 'text', value: Math.random().toString(36).slice(2, 10) });
  modal({
    title: `Reset password for ${u.username}`,
    body: h('div', { class: 'stack' }, field('New password', p), h('div', { class: 'small muted' }, 'The user will be signed out everywhere and must use the new password.')),
    actions: [{ label: 'Cancel' }, {
      label: 'Reset password', class: 'primary', onClick: async () => { await POST(`/api/admin/users/${u.id}/password`, { password: p.value }); ok('Password reset'); },
    }],
  });
}

/* ------------------------------------------------------------------ */
/* Admin: groups                                                       */
/* ------------------------------------------------------------------ */

async function pageAdminGroups(root, params, alive) {
  root.append(pageHead('Groups', 'Groups are created automatically from usernames (3-XXX → group 3). Give them names and review them here.'));
  const num = h('input', { type: 'number', class: 'compact', placeholder: 'Number', style: { width: '110px' } });
  const name = h('input', { type: 'text', class: 'compact', placeholder: 'Group name (optional)', style: { width: '240px' } });
  const wrap = h('div', { class: 'table-wrap' });
  root.append(h('div', { class: 'card' },
    h('form', {
      class: 'toolbar', onsubmit: async (e) => {
        e.preventDefault();
        if (num.value === '') return fail('Enter a group number');
        try { await PUT(`/api/admin/groups/${Number(num.value)}`, { name: name.value }); ok('Group saved'); num.value = ''; name.value = ''; load(); }
        catch (err) { fail(err); }
      },
    }, h('b', null, 'Add group'), num, name, h('button', { class: 'btn sm primary', type: 'submit' }, 'Add')),
    wrap));

  async function load() {
    const { groups } = await GET('/api/admin/groups');
    if (!alive()) return;
    if (!groups.length) { clear(wrap).append(emptyState('◫', 'No groups yet')); return; }
    clear(wrap).append(h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Group'), h('th', null, 'Name'), h('th', { class: 'num' }, 'Users'), h('th', null, 'Leader(s)'), h('th'))),
      h('tbody', null, groups.map((g) => h('tr', null,
        h('td', null, h('b', null, `Group ${g.number}`)),
        h('td', null, h('input', {
          type: 'text', class: 'compact', value: g.name, placeholder: 'Unnamed', style: { width: '260px' },
          onchange: async (e) => { try { await PUT(`/api/admin/groups/${g.number}`, { name: e.target.value }); ok('Renamed'); } catch (err) { fail(err); } },
        })),
        h('td', { class: 'num' }, g.user_count),
        h('td', null, g.leaders || h('span', { class: 'faint' }, 'No leader — set one in Users')),
        h('td', null, h('div', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
          h('a', { class: 'btn xs', href: `#/dashboard?group=${g.number}` }, 'Performance'),
          h('a', { class: 'btn xs', href: `#/jobs?group=${g.number}` }, 'Logs'),
          h('a', { class: 'btn xs', href: `#/admin/users?group=${g.number}` }, 'Users'),
          h('button', {
            class: 'btn xs danger', disabled: g.user_count > 0, title: g.user_count ? 'Only empty groups can be deleted' : '',
            onclick: async () => { try { await DEL(`/api/admin/groups/${g.number}`); ok('Group deleted'); load(); } catch (e) { fail(e); } },
          }, 'Delete'))))))));
  }
  await load();
}

/* ------------------------------------------------------------------ */
/* Admin: settings                                                     */
/* ------------------------------------------------------------------ */

async function pageAdminSettings(root, params, alive) {
  const { settings: s } = await GET('/api/admin/settings');
  if (!alive()) return;
  root.append(pageHead('Settings', 'Sign-up rules, default permissions, competition scoring and backups.'));

  const save = async (patch) => {
    try { await PUT('/api/admin/settings', patch); ok('Settings saved'); S.pub = await GET('/api/public/settings'); }
    catch (e) { fail(e); }
  };
  const settingRow = (title, desc, control) => h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'nowrap', padding: '14px 0', borderBottom: '1px solid var(--border)' } },
    h('div', null, h('b', null, title), h('div', { class: 'small muted' }, desc)), control);

  const pj = h('input', { type: 'number', step: '0.5', min: 0, value: s.points_job, style: { width: '100px' } });
  const pc = h('input', { type: 'number', step: '0.5', min: 0, value: s.points_contact, style: { width: '100px' } });
  const ps = h('input', { type: 'number', step: '0.5', min: 0, value: s.points_success, style: { width: '100px' } });

  root.append(h('div', { class: 'two-col' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Sign up & access')),
      h('div', { class: 'card-pad', style: { paddingTop: 0 } },
        settingRow('Allow sign up', 'When off, nobody can create an account from the sign-in page. Admins can still add users.',
          switchEl(s.signup_enabled === '1', (v) => save({ signup_enabled: v }))),
        settingRow('Require approval', 'New sign-ups stay disabled until an administrator approves them.',
          switchEl(s.require_approval === '1', (v) => save({ require_approval: v }))),
        settingRow('Default visibility for new users', 'What new members can see. Change per user or per group on the Users page.',
          select(Object.entries(SCOPE_LABEL), s.default_view_scope, { class: 'compact', style: { width: 'auto' }, onchange: (e) => save({ default_view_scope: e.target.value }) })))),
    h('div', { class: 'stack' },
      h('form', {
        class: 'card', onsubmit: (e) => { e.preventDefault(); save({ points_job: pj.value, points_contact: pc.value, points_success: ps.value }); },
      },
      h('div', { class: 'card-head' }, h('h2', null, 'Competition scoring')),
      h('div', { class: 'card-pad stack' },
        h('div', { class: 'small muted' }, 'Points decide group and member rankings on dashboards and the competition page.'),
        h('div', { class: 'row' }, field('Per job submitted', pj), field('Per person contacted', pc), field('Per successful contact', ps)),
        h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save scoring')))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Backup')),
        h('div', { class: 'card-pad stack' },
          h('div', { class: 'small muted' }, 'Download a full copy of the database (users, jobs, people, chat history). Restore by replacing data/crags.db while the app is stopped.'),
          h('div', null, h('a', { class: 'btn', href: '/api/admin/backup' }, '⬇ Download backup')))))));
}

boot();
