const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Preferencias de vista guardadas en el navegador (si se puede)
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('fids-prefs')) || {}; } catch { return {}; }
})();
function savePrefs() {
  try { localStorage.setItem('fids-prefs', JSON.stringify({ view: state.view, status: state.filter.status, group: state.filter.group })); } catch { /* sin almacenamiento */ }
}

const state = {
  devices: [],
  groups: {},
  roundRunning: false,
  view: prefs.view || 'grid',
  filter: { q: '', group: prefs.group || '', status: prefs.status || 'all' },
  refreshing: new Set(), // IPs con recaptura en curso
};

// ---------- utilidades ----------
function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}
function updateAges() {
  for (const el of $$('[data-ts]')) el.textContent = ago(Number(el.dataset.ts));
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Selector seguro para atributos data-* (IP y grupo vienen del inventario)
function cssEsc(s) {
  return window.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
}

// Iconos de la interfaz (SVG local, sin depender de fuentes de iconos)
const ICONS = {
  total: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  online: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 13a10 10 0 0 1 4.2-2.5"/><path d="M15 10.5A10 10 0 0 1 19 13"/><path d="M12 20h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></svg>',
  review: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
};
const STATUS_LABEL = { online: 'En línea', error: 'Con error', offline: 'Caído', pending: 'Revisando' };

// El resumen también filtra: cada tarjeta equivale a un estado del panel.
const SUMMARY_ITEMS = [
  { key: 'total', filter: 'all', label: 'Total equipos' },
  { key: 'online', filter: 'online', label: 'En línea' },
  { key: 'offline', filter: 'offline', label: 'Caídos' },
  { key: 'error', filter: 'error', label: 'Con error' },
  { key: 'review', filter: 'review', label: 'A revisar' },
];

function kpiHtml(item, value) {
  return `<button type="button" class="kpi" data-kpi="${item.filter}" aria-pressed="false" title="Filtrar: ${item.label}">
    <span class="kpiIcon ${item.key}">${ICONS[item.key]}</span>
    <span class="kpiBody"><span class="kpiLabel">${item.label}</span><strong class="kpiValue">${value}</strong></span>
  </button>`;
}

// Se actualiza en sitio para no perder el foco del botón mientras llegan refrescos.
function renderSummary(counts) {
  const box = $('#summary');
  if (!box.querySelector('.kpi[data-kpi]')) {
    box.innerHTML = SUMMARY_ITEMS.map((item) => kpiHtml(item, counts[item.key])).join('');
  }
  for (const btn of $$('#summary .kpi[data-kpi]')) {
    const item = SUMMARY_ITEMS.find((i) => i.filter === btn.dataset.kpi);
    if (!item) continue;
    const value = btn.querySelector('.kpiValue');
    if (value && value.textContent !== String(counts[item.key])) value.textContent = counts[item.key];
    const on = state.filter.status === item.filter;
    btn.classList.toggle('isActive', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function api(method, url, body, raw = false) {
  const opts = { method, headers: {} };
  // CSRF token para métodos mutantes
  const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase());
  if (mutating) {
    const csrf = getCookie('fids.csrf');
    if (csrf) opts.headers['X-CSRF-Token'] = csrf;
  }
  if (body !== undefined) {
    if (raw) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(url, opts);
  if (r.status === 401) {
    location.replace('/login.html');
    throw new Error('Sesión expirada');
  }
  if (r.status === 403) {
    const data = await r.json().catch(() => ({}));
    if (data.error?.includes('CSRF')) {
      // Token expirado: recargar para obtener uno nuevo
      location.reload();
      return;
    }
    throw new Error(data.error || 'Prohibido');
  }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

// ---------- panel lateral ----------
const shell = $('#appShell');
const sidebarToggle = $('#sidebarToggle');
const sidebarClose = $('#sidebarClose');
const sidebarOverlay = $('#sidebarOverlay');
const mobileNav = window.matchMedia('(max-width: 1023px)');
let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem('fids-sidebar') === 'collapsed'; } catch { /* sin almacenamiento */ }

function syncSidebar() {
  const mobile = mobileNav.matches;
  const open = shell.classList.contains('sidebar-mobile-open');
  shell.classList.toggle('sidebar-collapsed', !mobile && sidebarCollapsed);
  sidebarToggle.setAttribute('aria-expanded', String(mobile ? open : !sidebarCollapsed));
  sidebarToggle.setAttribute('aria-label', mobile
    ? (open ? 'Cerrar menú' : 'Abrir menú')
    : (sidebarCollapsed ? 'Expandir menú' : 'Contraer menú'));
  sidebarToggle.title = sidebarToggle.getAttribute('aria-label');
  sidebarOverlay.setAttribute('aria-hidden', String(!(mobile && open)));
  document.body.classList.toggle('sidebar-open', mobile && open);
}

function closeSidebarMobile() {
  if (!mobileNav.matches || !shell.classList.contains('sidebar-mobile-open')) return;
  shell.classList.remove('sidebar-mobile-open');
  syncSidebar();
}

function setSidebarCollapsed(value) {
  sidebarCollapsed = value;
  shell.classList.remove('sidebar-hover');
  try { localStorage.setItem('fids-sidebar', value ? 'collapsed' : 'expanded'); } catch { /* sin almacenamiento */ }
  syncSidebar();
}

sidebarToggle.addEventListener('click', () => {
  if (mobileNav.matches) shell.classList.toggle('sidebar-mobile-open');
  else setSidebarCollapsed(!sidebarCollapsed);
  syncSidebar();
});
sidebarClose.addEventListener('click', closeSidebarMobile);
sidebarOverlay.addEventListener('click', closeSidebarMobile);
sidebar.addEventListener('mouseenter', () => {
  if (!mobileNav.matches && sidebarCollapsed) shell.classList.add('sidebar-hover');
});
sidebar.addEventListener('mouseleave', () => shell.classList.remove('sidebar-hover'));
mobileNav.addEventListener('change', () => {
  shell.classList.remove('sidebar-mobile-open');
  shell.classList.remove('sidebar-hover');
  syncSidebar();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebarMobile();
});
for (const id of ['refreshAll', 'scanBtn', 'importBtn', 'addBtn', 'logoutBtn']) {
  $(`#${id}`).addEventListener('click', closeSidebarMobile);
}
syncSidebar();

// ---------- filtros ----------
function statusOf(d) {
  if (!d.status) return 'pending';
  if (!d.status.online) return 'offline';
  return d.thumbError ? 'error' : 'online';
}
function matches(d) {
  const f = state.filter;
  if (f.group && d.group !== f.group) return false;
  const st = statusOf(d);
  if (f.status === 'online' && !(st === 'online' || st === 'error')) return false;
  if (f.status === 'offline' && st !== 'offline') return false;
  if (f.status === 'error' && st !== 'error') return false;
  if (f.status === 'review' && !(st === 'error' || d.health?.level === 'warn')) return false;
  if (f.q) {
    const hay = `${d.name} ${d.description} ${d.ip} ${d.model || ''} ${d.groupLabel}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

// ---------- tarjetas y filas ----------
const ISSUES = {
  desktop: ['NG-Client', 'Se ve el escritorio de Windows en lugar del tablero de vuelos'],
  black: ['Pantalla negra', 'La pantalla está completamente negra'],
  blank: ['Pantalla en blanco', 'La pantalla es de un solo color'],
  baseline: ['Distinta a lo normal', 'Se ve muy diferente a la pantalla que marcaste como normal'],
};
// Alertas de la pantalla (deducidas de la imagen) + "sin cambios" como dato
function healthHtml(d) {
  const h = d.health;
  if (!h) return '';
  const warn = h.issues.map((i) => `<span class="hb warn" title="${ISSUES[i][1]}">${ISSUES[i][0]}</span>`).join('');
  const frozen = h.frozen ? `<span class="hb info" title="La imagen no ha cambiado desde entonces">Sin cambios <span data-ts="${h.unchangedSince}"></span></span>` : '';
  return warn || frozen ? `<div class="health">${warn}${frozen}</div>` : '';
}

function thumbHtml(d) {
  const st = d.status;
  if (st && !st.online) {
    // Caído: no se abre el visor. Si hay una captura vieja se muestra apagada, con el aviso encima
    return `${d.thumbAt ? `<img class="stale" src="/thumb/${encodeURIComponent(d.ip)}?t=${d.thumbAt}" alt="">` : ''}
      <span class="downMsg">Caído · sin respuesta en puerto VNC${st.lastSeen ? `<br>visto <span data-ts="${st.lastSeen}"></span>` : ''}</span>`;
  }
  if (d.thumbAt) {
    // El texto "hace X" lo llena updateAges(): así el HTML no cambia en cada refresco
    return `<img src="/thumb/${encodeURIComponent(d.ip)}?t=${d.thumbAt}" alt=""><span class="age" data-ts="${d.thumbAt}"></span>`;
  }
  return `<span>${!st ? 'Revisando…' : d.thumbError ? 'Sin miniatura' : 'Capturando…'}</span>`;
}
const viewUrl = (d, force) => `/view.html?ip=${encodeURIComponent(d.ip)}${force ? '&force=1' : ''}`;
function badges(d) {
  return `${d.hasPassword ? '<span class="badge" title="Usa contraseña propia">Clave propia</span>' : ''}${d.manual ? '<span class="badge" title="Agregado a mano">Manual</span>' : ''}`;
}
function actionBtns(d, withRetry = true) {
  const busy = state.refreshing.has(d.ip);
  const retry = withRetry && d.status && !d.status.online
    ? `<a class="btnLink small retryLink" href="${viewUrl(d, true)}" title="Abrir el visor aunque el equipo aparezca caído (por si acaba de encender)">Intentar de todos modos</a>`
    : '';
  return `${retry}<button class="icon" data-act="refresh" data-ip="${esc(d.ip)}" title="Volver a sacar la miniatura" aria-label="Actualizar ${esc(d.name)}" ${busy ? 'disabled' : ''}>${busy ? '…' : ICONS.refresh}</button>
    <button class="icon" data-act="edit" data-ip="${esc(d.ip)}" title="Editar equipo" aria-label="Editar ${esc(d.name)}">${ICONS.edit}</button>`;
}
function card(d) {
  const st = statusOf(d);
  const off = st === 'offline';
  // Los caídos no son enlace: el visor solo se abre con "Intentar de todos modos"
  const statusPill = `<span class="cardStatus"><span class="dot ${st}"></span>${STATUS_LABEL[st]}</span>`;
  const thumb = off
    ? `<div class="thumb">${thumbHtml(d)}${statusPill}</div>`
    : `<a class="thumb" href="${viewUrl(d)}" title="Abrir ${esc(d.name)} en vivo${d.resolution ? ' — ' + esc(d.resolution) : ''}">${thumbHtml(d)}${statusPill}</a>`;
  const name = off ? `<span class="name">${esc(d.name)}</span>` : `<a class="name" href="${viewUrl(d)}">${esc(d.name)}</a>`;
  const retry = off
    ? `<a class="btnLink small retryLink" href="${viewUrl(d, true)}" title="Abrir el visor aunque el equipo aparezca caído (por si acaba de encender)">Intentar de todos modos</a>`
    : '';
  return `
    <div class="card ${st} ${d.health?.level === 'warn' ? 'warnScreen' : ''}" data-ip="${esc(d.ip)}">
      ${thumb}
      <div class="info">
        <div class="row cardTitle"><span class="dot ${st}"></span>${name}<span class="ip">${esc(d.ip)}</span></div>
        <div class="row"><span class="desc">${esc(d.description || d.model || '')}</span></div>
        ${healthHtml(d)}
        ${d.thumbError && d.status?.online ? `<div class="err">${esc(d.thumbError)}</div>` : ''}
        ${retry}
        <div class="cardFoot">
          <div class="badges">${badges(d)}</div>
          <div class="btns">${actionBtns(d, false)}</div>
        </div>
      </div>
    </div>`;
}
function rowHtml(d) {
  const st = statusOf(d);
  const off = st === 'offline';
  const label = STATUS_LABEL[st];
  const img = d.thumbAt ? `<img ${off ? 'class="stale"' : ''} src="/thumb/${encodeURIComponent(d.ip)}?t=${d.thumbAt}" alt="">` : '';
  return `
    <tr class="${st}" data-ip="${esc(d.ip)}">
      <td class="mini">${off ? `<span class="miniBox">${img}</span>` : `<a href="${viewUrl(d)}">${img}</a>`}</td>
      <td class="st"><span class="pill ${st}"><span class="dot ${st}"></span>${label}</span></td>
      <td>${off ? `<span class="name">${esc(d.name)}</span>` : `<a class="name" href="${viewUrl(d)}">${esc(d.name)}</a>`} ${badges(d)}</td>
      <td class="desc">${esc(d.description || '')}</td>
      <td class="ip">${esc(d.ip)}</td>
      <td>${esc(d.resolution || '')}</td>
      <td>${d.thumbAt ? `<span data-ts="${d.thumbAt}"></span>` : ''}</td>
      <td>${healthHtml(d)}</td>
      <td class="err">${d.status?.online && d.thumbError ? esc(d.thumbError) : ''}</td>
      <td class="btns">${actionBtns(d)}</td>
    </tr>`;
}

// ---------- render ----------
let lastLayout = '';
const lastHtml = new Map(); // ip -> html mostrado

function groupHeader(g) {
  const off = g.items.filter((d) => d.status?.online === false).length;
  return `${esc(g.label)} <small>${g.items.length} equipos${off ? ` · ${off} caídos` : ''}</small>`;
}

function render() {
  const list = state.devices.filter(matches);
  const groups = new Map();
  for (const d of list) {
    if (!groups.has(d.group)) groups.set(d.group, { key: d.group, label: d.groupLabel, items: [] });
    groups.get(d.group).items.push(d);
  }
  const item = state.view === 'grid' ? card : rowHtml;
  // Si cambian los equipos visibles o la vista se redibuja todo; si no, solo lo que cambió,
  // para no tirar las imágenes que el navegador está cargando
  const layout = `${state.view}|${list.map((d) => d.ip).join(',')}`;
  if (layout !== lastLayout) {
    lastLayout = layout;
    lastHtml.clear();
    const body = (g) => {
      const items = g.items.map((d) => { const h = item(d); lastHtml.set(d.ip, h); return h; }).join('');
      return state.view === 'grid'
        ? `<div class="grid">${items}</div>`
        : `<div class="tableWrap"><table class="list"><thead><tr><th></th><th>Estado</th><th>Nombre</th><th>Ubicación</th><th>IP</th><th>Resolución</th><th>Captura</th><th>Pantalla</th><th>Error</th><th></th></tr></thead><tbody>${items}</tbody></table></div>`;
    };
    $('#groups').innerHTML = list.length
      ? [...groups.values()].map((g) => `<section class="group"><div class="groupHead"><h2 data-group="${esc(g.key)}">${groupHeader(g)}</h2></div>${body(g)}</section>`).join('')
      : '<div class="empty">Ningún equipo coincide con el filtro.</div>';
  } else {
    for (const g of groups.values()) {
      // Buscar por dataset evita romper el selector si la zona trae comillas
      const h2 = $$('#groups h2[data-group]').find((el) => el.dataset.group === g.key);
      if (h2) h2.innerHTML = groupHeader(g);
    }
    for (const d of list) {
      const h = item(d);
      if (lastHtml.get(d.ip) === h) continue;
      const el = $(`[data-ip="${cssEsc(d.ip)}"].card, tr[data-ip="${cssEsc(d.ip)}"]`);
      if (el) el.outerHTML = h;
      lastHtml.set(d.ip, h);
    }
  }
  updateAges();

  const all = state.devices;
  const count = (s) => all.filter((d) => statusOf(d) === s).length;
  const review = all.filter((d) => statusOf(d) === 'error' || d.health?.level === 'warn').length;
  const counts = {
    total: all.length,
    online: count('online') + count('error'),
    offline: count('offline'),
    error: count('error'),
    review,
  };
  for (const [key, value] of Object.entries(counts)) {
    const el = $(`#statusSeg [data-count="${key}"]`);
    if (el) el.textContent = value;
  }
  renderSummary(counts);
  const round = $('#roundState');
  if (round) round.hidden = !state.roundRunning;
}

function fillGroupSelects() {
  const used = new Map(state.devices.map((d) => [d.group, d.groupLabel]));
  const sel = $('#group');
  const cur = state.filter.group;
  sel.innerHTML = '<option value="">Todas las zonas</option>' +
    [...used].map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  sel.value = used.has(cur) ? cur : '';
  state.filter.group = sel.value;
  $('#devForm [name=group]').innerHTML = Object.entries(state.groups)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
}

async function load() {
  try {
    const data = await api('GET', '/api/devices');
    const groupsChanged = JSON.stringify(Object.keys(state.groups)) !== JSON.stringify(Object.keys(data.groups))
      || new Set(data.devices.map((d) => d.group)).size !== new Set(state.devices.map((d) => d.group)).size;
    state.devices = data.devices;
    state.groups = data.groups;
    state.roundRunning = data.roundRunning;
    if (groupsChanged) fillGroupSelects();
    render();
  } catch (e) {
    $('#summary').innerHTML = `<div class="notice">Sin conexión con el servidor: ${esc(e.message)}</div>`;
    const round = $('#roundState');
    if (round) round.hidden = true;
  }
}

// ---------- acciones por equipo ----------
async function refreshOne(ip) {
  state.refreshing.add(ip);
  render();
  try {
    const d = await api('POST', `/api/devices/${encodeURIComponent(ip)}/refresh`);
    const i = state.devices.findIndex((x) => x.ip === ip);
    if (i >= 0) state.devices[i] = d;
    if (d.thumbError) toast(`${d.name}: ${d.thumbError}`, true);
    else if (!d.status?.online) toast(`${d.name}: no responde en el puerto VNC`, true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.refreshing.delete(ip);
    render();
  }
}

$('#groups').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  e.preventDefault();
  if (b.dataset.act === 'refresh') refreshOne(b.dataset.ip);
  if (b.dataset.act === 'edit') openDevDialog(state.devices.find((d) => d.ip === b.dataset.ip));
});

// ---------- diálogo agregar / editar ----------
let editingIp = null;
function openDevDialog(d, prefill = {}) {
  const f = $('#devForm');
  f.reset();
  editingIp = d ? d.ip : null;
  $('#devTitle').textContent = d ? `Editar ${d.name}` : 'Agregar equipo';
  const v = d || prefill;
  f.elements.name.value = v.name || '';
  f.elements.ip.value = v.ip || '';
  f.elements.description.value = v.description || '';
  f.elements.group.value = v.group || 'OTROS';
  f.elements.port.value = v.port || '';
  f.elements.password.placeholder = d?.hasPassword ? '•••••• (guardada; escribe otra para cambiarla)' : 'Vacío = usar la contraseña general';
  $('#clearPwRow').hidden = !d?.hasPassword;
  $('#devDelete').hidden = !d;
  renderRefs(d);
  $('#devErr').hidden = true;
  $('#devDialog').showModal();
  (d ? f.elements.name : (v.ip ? f.elements.name : f.elements.ip)).focus();
}
$('#addBtn').addEventListener('click', () => openDevDialog(null));

// ---------- referencias de pantalla (en el diálogo de edición) ----------
function renderRefs(d) {
  const box = $('#screenRefs');
  box.hidden = !d;
  if (!d) return;
  const h = d.health;
  const now = h ? (h.issues.length ? h.issues.map((i) => ISSUES[i][0]).join(', ') : 'sin alertas') : 'sin captura todavía';
  $('#refsInfo').textContent = `Ahora: ${now}.${d.hasBaseline ? ` Tiene referencia de pantalla normal (diferencia actual ${h?.baselineDiff ?? '—'}).` : ''}`;
  $('#clearBaseline').hidden = !d.hasBaseline;
  $('#setBaseline').textContent = d.hasBaseline ? '✓ Actualizar referencia normal' : '✓ Así se ve normal';
}
async function refAction(method, url, body, okMsg) {
  try {
    await api(method, url, body);
    toast(okMsg);
    await load();
    const d = state.devices.find((x) => x.ip === editingIp);
    if (d) renderRefs(d);
  } catch (err) {
    toast(err.message, true);
  }
}
$('#setBaseline').addEventListener('click', () =>
  refAction('POST', `/api/devices/${editingIp}/baseline`, undefined, 'Pantalla actual guardada como normal'));
$('#clearBaseline').addEventListener('click', () =>
  refAction('DELETE', `/api/devices/${editingIp}/baseline`, undefined, 'Referencia quitada'));
$('#markDesktop').addEventListener('click', () => {
  if (!confirm('¿La pantalla actual de este equipo es el escritorio de Windows (NG-Client cerrado)? Su color de fondo se usará para reconocerlo en todos los equipos.')) return;
  refAction('POST', '/api/desktop-refs', { ip: editingIp }, 'Color de escritorio agregado');
});

$('#devForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.elements.name.value, ip: f.elements.ip.value, description: f.elements.description.value,
    group: f.elements.group.value, groupLabel: state.groups[f.elements.group.value],
    port: f.elements.port.value, password: f.elements.password.value, clearPassword: f.elements.clearPassword.checked,
  };
  $('#devSave').disabled = true;
  $('#devSave').textContent = 'Guardando y probando…';
  try {
    const d = editingIp
      ? await api('PUT', `/api/devices/${editingIp}`, body)
      : await api('POST', '/api/devices', body);
    $('#devDialog').close();
    toast(editingIp ? `${d.name} actualizado` : `${d.name} agregado`);
    if (d.thumbError) toast(`${d.name}: ${d.thumbError}`, true);
    await load();
  } catch (err) {
    $('#devErr').textContent = err.message;
    $('#devErr').hidden = false;
  } finally {
    $('#devSave').disabled = false;
    $('#devSave').textContent = 'Guardar';
  }
});

$('#devDelete').addEventListener('click', async () => {
  const d = state.devices.find((x) => x.ip === editingIp);
  if (!d || !confirm(`¿Eliminar ${d.name} (${d.ip}) de la lista?`)) return;
  try {
    await api('DELETE', `/api/devices/${d.ip}`);
    $('#devDialog').close();
    toast(`${d.name} eliminado`);
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

for (const b of $$('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// ---------- buscar equipos nuevos ----------
$('#scanBtn').addEventListener('click', () => {
  const prefixes = [...new Set(state.devices.map((d) => d.ip.split('.').slice(0, 3).join('.')))];
  $('#scanForm').elements.prefix.placeholder = prefixes.join(', ') || '192.168.10';
  $('#scanDialog').showModal();
});
$('#scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#scanGo');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  $('#scanResults').innerHTML = '<p class="muted">Revisando la red y probando la contraseña en lo que aparezca. Puede tardar un minuto.</p>';
  try {
    const r = await api('POST', '/api/scan', { prefix: e.target.elements.prefix.value || undefined });
    $('#scanResults').innerHTML = r.results.length
      ? `<p class="muted">Red revisada: ${esc(r.prefixes.join(', '))}. ${r.results.length} equipo(s) con VNC que no están en la lista:</p>
         <div class="scanGrid">${r.results.map((x) => `
           <div class="scanItem">
             <div class="thumb">${x.thumb ? `<img src="${esc(x.thumb)}" alt="">` : '<span>Sin imagen</span>'}</div>
             <div class="info">
               <b>${esc(x.ip)}</b> ${x.resolution ? `<span class="muted">${esc(x.resolution)}</span>` : ''}
               <div class="${x.ok ? 'okTxt' : 'err'}">${x.ok ? 'Entra con la contraseña general' : esc(x.error)}</div>
               <button data-add="${esc(x.ip)}" class="primary small">＋ Agregar</button>
             </div>
           </div>`).join('')}</div>`
      : `<p class="muted">Red revisada: ${esc(r.prefixes.join(', '))}. No hay equipos nuevos con VNC abierto.</p>`;
  } catch (err) {
    $('#scanResults').innerHTML = `<p class="err">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar';
  }
});
$('#scanResults').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-add]');
  if (!b) return;
  $('#scanDialog').close();
  openDevDialog(null, { ip: b.dataset.add });
});

// ---------- importar Excel ----------
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('Importando…');
  try {
    const r = await api('POST', '/api/import', await file.arrayBuffer(), true);
    toast(`Excel importado: ${r.added} nuevos, ${r.updated} actualizados (${r.total} en total)`);
    await load();
  } catch (err) {
    toast(`No se pudo importar: ${err.message}`, true);
  }
});

// ---------- barra de filtros ----------
$('#refreshAll').addEventListener('click', async () => {
  await api('POST', '/api/refresh-all').catch((e) => toast(e.message, true));
  toast('Revisando todos los equipos…');
  load();
});
$('#search').addEventListener('input', (e) => { state.filter.q = e.target.value.trim().toLowerCase(); render(); });
$('#group').addEventListener('change', (e) => { state.filter.group = e.target.value; savePrefs(); render(); closeSidebarMobile(); });

function syncSeg(id, value) {
  for (const b of $$(`${id} button`)) {
    const on = b.dataset.v === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function setStatusFilter(value) {
  state.filter.status = value;
  syncSeg('#statusSeg', state.filter.status);
  savePrefs();
  render();
  closeSidebarMobile();
}

$('#summary').addEventListener('click', (e) => {
  const kpi = e.target.closest('.kpi[data-kpi]');
  if (!kpi) return;
  setStatusFilter(kpi.dataset.kpi);
});

function bindSeg(id, get, set) {
  const seg = $(id);
  const sync = () => syncSeg(id, get());
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    sync();
    savePrefs();
    render();
    closeSidebarMobile();
  });
  sync();
}
bindSeg('#statusSeg', () => state.filter.status, (v) => { state.filter.status = v; });
bindSeg('#viewSeg', () => state.view, (v) => { state.view = v; });

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    location.replace('/login.html');
  }
});

load();
setInterval(load, 5000);
setInterval(updateAges, 10000);
