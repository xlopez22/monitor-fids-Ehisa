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
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
async function api(method, url, body, raw = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (raw) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(url, opts);
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

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
  desktop: ['⚠ NG-Client no visible', 'Se ve el escritorio de Windows en lugar del tablero de vuelos'],
  black: ['⚠ Pantalla negra', 'La pantalla está completamente negra'],
  blank: ['⚠ Pantalla en blanco', 'La pantalla es de un solo color'],
  baseline: ['⚠ Distinta a lo normal', 'Se ve muy diferente a la pantalla que marcaste como normal'],
};
// Alertas de la pantalla (deducidas de la imagen) + "sin cambios" como dato
function healthHtml(d) {
  const h = d.health;
  if (!h) return '';
  const warn = h.issues.map((i) => `<span class="hb warn" title="${ISSUES[i][1]}">${ISSUES[i][0]}</span>`).join('');
  const frozen = h.frozen ? `<span class="hb info" title="La imagen no ha cambiado desde entonces">⏸ sin cambios <span data-ts="${h.unchangedSince}"></span></span>` : '';
  return warn || frozen ? `<div class="health">${warn}${frozen}</div>` : '';
}

function thumbHtml(d) {
  const st = d.status;
  if (st && !st.online) {
    // Caído: no se abre el visor. Si hay una captura vieja se muestra apagada, con el aviso encima
    return `${d.thumbAt ? `<img class="stale" src="/thumb/${d.ip}?t=${d.thumbAt}" alt="">` : ''}
      <span class="downMsg">Caído · sin respuesta en puerto VNC${st.lastSeen ? `<br>visto <span data-ts="${st.lastSeen}"></span>` : ''}</span>`;
  }
  if (d.thumbAt) {
    // El texto "hace X" lo llena updateAges(): así el HTML no cambia en cada refresco
    return `<img src="/thumb/${d.ip}?t=${d.thumbAt}" alt=""><span class="age" data-ts="${d.thumbAt}"></span>`;
  }
  return `<span>${!st ? 'Revisando…' : d.thumbError ? 'Sin miniatura' : 'Capturando…'}</span>`;
}
const viewUrl = (d, force) => `/view.html?ip=${d.ip}${force ? '&force=1' : ''}`;
function badges(d) {
  return `${d.hasPassword ? '<span class="badge" title="Usa contraseña propia">🔑</span>' : ''}${d.manual ? '<span class="badge" title="Agregado a mano">manual</span>' : ''}`;
}
function actionBtns(d) {
  const busy = state.refreshing.has(d.ip);
  const retry = d.status && !d.status.online
    ? `<a class="btnLink small" href="${viewUrl(d, true)}" title="Abrir el visor aunque el equipo aparezca caído (por si acaba de encender)">Intentar de todos modos</a>`
    : '';
  return `${retry}<button class="icon" data-act="refresh" data-ip="${d.ip}" title="Volver a sacar la miniatura" ${busy ? 'disabled' : ''}>${busy ? '…' : '↻'}</button>
    <button class="icon" data-act="edit" data-ip="${d.ip}" title="Editar equipo">✎</button>`;
}
function card(d) {
  const st = statusOf(d);
  const off = st === 'offline';
  // Los caídos no son enlace: el visor solo se abre con "Intentar de todos modos"
  const thumb = off
    ? `<div class="thumb">${thumbHtml(d)}</div>`
    : `<a class="thumb" href="${viewUrl(d)}" title="Abrir ${esc(d.name)} en vivo${d.resolution ? ' — ' + d.resolution : ''}">${thumbHtml(d)}</a>`;
  const name = off ? `<span class="name">${esc(d.name)}</span>` : `<a class="name" href="${viewUrl(d)}">${esc(d.name)}</a>`;
  return `
    <div class="card ${st} ${d.health?.level === 'warn' ? 'warnScreen' : ''}" data-ip="${d.ip}">
      ${thumb}
      <div class="info">
        <div class="row"><span class="dot ${st}"></span>${name}${badges(d)}<span class="ip">${d.ip}</span></div>
        <div class="row"><span class="desc">${esc(d.description || d.model || '')}</span><span class="btns">${actionBtns(d)}</span></div>
        ${healthHtml(d)}
        ${d.thumbError && d.status?.online ? `<div class="err">${esc(d.thumbError)}</div>` : ''}
      </div>
    </div>`;
}
function rowHtml(d) {
  const st = statusOf(d);
  const off = st === 'offline';
  const label = { online: 'En línea', error: 'Con error', offline: 'Caído', pending: 'Revisando' }[st];
  const img = d.thumbAt ? `<img ${off ? 'class="stale"' : ''} src="/thumb/${d.ip}?t=${d.thumbAt}" alt="">` : '';
  return `
    <tr class="${st}" data-ip="${d.ip}">
      <td class="mini">${off ? `<span class="miniBox">${img}</span>` : `<a href="${viewUrl(d)}">${img}</a>`}</td>
      <td class="st"><span class="dot ${st}"></span> ${label}</td>
      <td>${off ? `<span class="name">${esc(d.name)}</span>` : `<a class="name" href="${viewUrl(d)}">${esc(d.name)}</a>`} ${badges(d)}</td>
      <td class="desc">${esc(d.description || '')}</td>
      <td class="ip">${d.ip}</td>
      <td>${d.resolution || ''}</td>
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
      ? [...groups.values()].map((g) => `<section><h2 data-group="${g.key}">${groupHeader(g)}</h2>${body(g)}</section>`).join('')
      : '<div class="empty">Ningún equipo coincide con el filtro.</div>';
  } else {
    for (const g of groups.values()) {
      const h2 = $(`h2[data-group="${g.key}"]`);
      if (h2) h2.innerHTML = groupHeader(g);
    }
    for (const d of list) {
      const h = item(d);
      if (lastHtml.get(d.ip) === h) continue;
      const el = $(`[data-ip="${d.ip}"].card, tr[data-ip="${d.ip}"]`);
      if (el) el.outerHTML = h;
      lastHtml.set(d.ip, h);
    }
  }
  updateAges();

  const all = state.devices;
  const count = (s) => all.filter((d) => statusOf(d) === s).length;
  $('#summary').innerHTML = `<span>Total <b>${all.length}</b></span>
    <span class="ok">En línea <b>${count('online') + count('error')}</b></span>
    <span class="bad">Caídos <b>${count('offline')}</b></span>
    ${count('error') ? `<span class="warn">Con error <b>${count('error')}</b></span>` : ''}
    ${(() => { const n = all.filter((d) => d.health?.level === 'warn').length; return n ? `<span class="warn">Pantalla a revisar <b>${n}</b></span>` : ''; })()}
    ${state.roundRunning ? '<span class="muted">revisando…</span>' : ''}`;
}

function fillGroupSelects() {
  const used = new Map(state.devices.map((d) => [d.group, d.groupLabel]));
  const sel = $('#group');
  const cur = state.filter.group;
  sel.innerHTML = '<option value="">Todas las zonas</option>' +
    [...used].map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  sel.value = used.has(cur) ? cur : '';
  state.filter.group = sel.value;
  $('#devForm [name=group]').innerHTML = Object.entries(state.groups)
    .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
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
    $('#summary').innerHTML = `<span class="bad">Sin conexión con el servidor: ${esc(e.message)}</span>`;
  }
}

// ---------- acciones por equipo ----------
async function refreshOne(ip) {
  state.refreshing.add(ip);
  render();
  try {
    const d = await api('POST', `/api/devices/${ip}/refresh`);
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
      ? `<p class="muted">Red revisada: ${r.prefixes.join(', ')}. ${r.results.length} equipo(s) con VNC que no están en la lista:</p>
         <div class="scanGrid">${r.results.map((x) => `
           <div class="scanItem">
             <div class="thumb">${x.thumb ? `<img src="${x.thumb}" alt="">` : '<span>Sin imagen</span>'}</div>
             <div class="info">
               <b>${x.ip}</b> ${x.resolution ? `<span class="muted">${x.resolution}</span>` : ''}
               <div class="${x.ok ? 'okTxt' : 'err'}">${x.ok ? 'Entra con la contraseña general' : esc(x.error)}</div>
               <button data-add="${x.ip}" class="primary small">＋ Agregar</button>
             </div>
           </div>`).join('')}</div>`
      : `<p class="muted">Red revisada: ${r.prefixes.join(', ')}. No hay equipos nuevos con VNC abierto.</p>`;
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
$('#group').addEventListener('change', (e) => { state.filter.group = e.target.value; savePrefs(); render(); });

function bindSeg(id, get, set) {
  const seg = $(id);
  const sync = () => $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    sync();
    savePrefs();
    render();
  });
  sync();
}
bindSeg('#statusSeg', () => state.filter.status, (v) => { state.filter.status = v; });
bindSeg('#viewSeg', () => state.view, (v) => { state.view = v; });

load();
setInterval(load, 5000);
setInterval(updateAges, 10000);
