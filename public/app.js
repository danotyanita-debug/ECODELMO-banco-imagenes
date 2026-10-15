'use strict';
/* Monitoreo de obras – PWA (sin dependencias). Todo el HTML dinámico pasa por html`` que escapa por defecto. */

// ---------- utilidades ----------
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => escMap[c]);
const raw = (s) => new Safe(s);
const html = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => {
  let v = vals[i - 1];
  if (Array.isArray(v)) v = v.map((x) => (x instanceof Safe ? x.s : esc(x))).join('');
  else if (v instanceof Safe) v = v.s;
  else v = esc(v);
  return out + v + s;
}));
const $ = (sel, root = document) => root.querySelector(sel);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const money = (n) => Number(n || 0).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => Number(n || 0).toLocaleString('es-BO', { maximumFractionDigits: 3 });
const fmtDT = (s) => (s ? s.replace('T', ' ').slice(0, 16) : '');
const bar = (p, cls = '') => html`<div class="bar ${cls}"><i style="width:${Math.min(100, Math.max(0, p || 0))}%"></i></div>`;
const ESTADOS = { planificada: 'Planificada', en_ejecucion: 'En ejecución', paralizada: 'Paralizada', terminada: 'Terminada' };
const ROLES = { admin: 'Administrador', supervisor: 'Supervisor', residente: 'Residente', lector: 'Solo lectura' };

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------- IndexedDB (caché de lecturas + cola de envíos) ----------
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('obras-app', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('cache');
      r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
    put: (s, v, k) => tx(s, 'readwrite', (o) => o.put(v, k)),
    add: (s, v) => tx(s, 'readwrite', (o) => o.add(v)),
    del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
    all: (s) => tx(s, 'readonly', (o) => o.getAll()),
    clear: (s) => tx(s, 'readwrite', (o) => o.clear()),
  };
})();

// ---------- API ----------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
class NetError extends Error {}
const state = { me: null, offline: false };

async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new NetError('Sin conexión'); }
  let data = null;
  try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (!r.ok) {
    if (r.status === 401 && state.me && !url.endsWith('/login')) { state.me = null; location.hash = '#/login'; }
    throw new ApiError(r.status, (data && data.error) || `Error ${r.status}`);
  }
  return data;
}

async function get(url) {
  try {
    const d = await api('GET', url);
    state.offline = false; $('#offline').hidden = true;
    idb.put('cache', d, url).catch(() => {});
    return d;
  } catch (e) {
    if (e instanceof NetError) {
      const c = await idb.get('cache', url).catch(() => undefined);
      if (c !== undefined) { state.offline = true; $('#offline').hidden = false; return c; }
    }
    throw e;
  }
}

// Envíos que deben sobrevivir sin conexión
const ENDPOINT = { avance: 'avances', bitacora: 'bitacora', foto: 'fotos', pago: 'pagos' };
async function send(kind, obraId, payload, label) {
  payload = { ...payload, client_uuid: payload.client_uuid || uid() };
  try {
    await api('POST', `/api/obras/${obraId}/${ENDPOINT[kind]}`, payload);
    return { queued: false };
  } catch (e) {
    if (!(e instanceof NetError)) throw e;
    await idb.add('outbox', { kind, obraId, payload, label, creado: new Date().toISOString(), error: null });
    updateBadge();
    return { queued: true };
  }
}

let flushing = false;
async function flush() {
  if (flushing || !state.me || !navigator.onLine) return;
  flushing = true;
  let sent = 0;
  try {
    const items = (await idb.all('outbox')).sort((a, b) => a.id - b.id);
    for (const it of items) {
      if (it.error) continue;
      try {
        await api('POST', `/api/obras/${it.obraId}/${ENDPOINT[it.kind]}`, it.payload);
        await idb.del('outbox', it.id); sent++;
      } catch (e) {
        if (e instanceof NetError || (e instanceof ApiError && e.status === 401)) break;
        await idb.put('outbox', { ...it, error: e.message });   // rechazado por el servidor: queda para revisión
      }
    }
  } finally { flushing = false; updateBadge(); }
  if (sent) { toast(`${sent} registro(s) sincronizado(s)`); if (/^#\/(obra|sync|$)/.test(location.hash) || !location.hash) route(); }
}

async function updateBadge() {
  const n = (await idb.all('outbox').catch(() => [])).length;
  const b = $('#syncbadge'); b.hidden = !n; b.textContent = `⏳ ${n}`;
}

// ---------- hojas modales ----------
function openSheet(content) {
  const s = $('#sheet'); s.innerHTML = `<div class="panel">${content}</div>`; s.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; document.body.style.overflow = ''; }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

// ---------- fotos: reducir, sellar fecha/GPS ----------
function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });
}
async function processPhoto(file, pos, obraNombre) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(async () => {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img;
  });
  const MAX = 1600; const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, w, h);
  const now = new Date(); const stamp = `${obraNombre} · ${now.toLocaleString('es-BO')}` + (pos ? ` · ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : '');
  const fs = Math.max(12, Math.round(w / 45));
  g.font = `${fs}px sans-serif`; g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, h - fs * 1.9, w, fs * 1.9);
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(stamp, fs * .6, h - fs * .95, w - fs);
  return { data: c.toDataURL('image/jpeg', 0.8), tomada_en: new Date(now - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 19) };
}
// Selector de fotos reutilizable dentro de formularios. Guarda archivos en `picked[formId]`.
const picked = {};
function photoPicker(id) {
  picked[id] = [];
  return html`<label>Fotos</label>
    <div class="row wrap">
      <button type="button" class="sec sm" data-action="pick" data-id="${id}" data-cam="1">📷 Tomar foto</button>
      <button type="button" class="sec sm" data-action="pick" data-id="${id}">🖼 Galería</button>
    </div><div class="thumbs" id="thumbs-${id}"></div>`;
}
function pickFiles(id, cam) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; if (cam) inp.capture = 'environment';
  inp.onchange = () => {
    for (const f of inp.files) {
      picked[id].push(f);
      const im = document.createElement('img'); im.src = URL.createObjectURL(f); $(`#thumbs-${id}`).append(im);
    }
  };
  inp.click();
}
async function sendPhotos(id, obraId, obra, extra) {
  const files = picked[id] || []; if (!files.length) return 0;
  const pos = await getPosition();
  let q = 0;
  for (const f of files) {
    const p = await processPhoto(f, pos, obra.nombre);
    const r = await send('foto', obraId, { ...p, lat: pos?.lat ?? null, lng: pos?.lng ?? null, ...extra }, `Foto – ${obra.nombre}`);
    if (r.queued) q++;
  }
  picked[id] = []; return q;
}

// ---------- vistas ----------
const main = $('#main');
const setTitle = (t, back) => {
  $('#title').textContent = t; $('#top').hidden = !state.me;
  const b = $('#back'); b.hidden = !back; b.dataset.href = back || '';
  document.title = `${t} · Obras`;
};
const spinner = () => { main.innerHTML = '<p class="center muted">Cargando…</p>'; };
function showError(e) {
  if (e instanceof ApiError && e.status === 401) return;
  main.innerHTML = html`<div class="card center"><p>${e instanceof NetError ? 'Sin conexión y sin datos guardados para esta pantalla.' : e.message}</p><button data-action="reload">Reintentar</button></div>`.s;
}

async function viewLogin() {
  setTitle('Obras'); $('#top').hidden = true;
  const st = await api('GET', '/api/status');
  main.innerHTML = html`<div class="login card">
    <h2>${st.needsSetup ? 'Crear administrador' : 'Iniciar sesión'}</h2>
    <p class="muted center small">${st.needsSetup ? 'Primera vez: crea la cuenta del administrador.' : 'Monitoreo y seguimiento de obras'}</p>
    <form data-form="${st.needsSetup ? 'setup' : 'login'}">
      ${st.needsSetup ? html`<label>Nombre</label><input name="nombre" required autocomplete="name">` : ''}
      <label>Correo</label><input name="email" type="email" required autocomplete="username" inputmode="email">
      <label>Contraseña ${st.needsSetup ? '(mín. 8 caracteres)' : ''}</label>
      <input name="password" type="password" required minlength="${st.needsSetup ? 8 : 1}" autocomplete="${st.needsSetup ? 'new-password' : 'current-password'}">
      <p class="err" id="err"></p>
      <button style="width:100%">${st.needsSetup ? 'Crear y entrar' : 'Entrar'}</button>
    </form></div>`.s;
}

async function viewObras() {
  setTitle('Mis obras'); spinner();
  const obras = await get('/api/obras');
  const staff = ['admin', 'supervisor'].includes(state.me.rol);
  const crit = obras.filter((o) => o.resumen.semaforo === 'rojo').length;
  const inc = obras.reduce((s, o) => s + o.resumen.incidencias_abiertas, 0);
  main.innerHTML = html`
    ${obras.length ? html`<div class="kpis">
      <div class="kpi"><b>${obras.length}</b><span>Obras</span></div>
      <div class="kpi"><b>${inc}</b><span>Incidencias abiertas${crit ? ` · ${crit} atrasada(s)` : ''}</span></div></div>
      <input id="filtro" type="search" placeholder="Buscar obra…" style="margin-bottom:10px">` : ''}
    <div id="lista">${obras.map(obraCard)}</div>
    ${obras.length ? '' : html`<div class="card center"><p>No tienes obras asignadas.</p>${staff ? html`<p class="muted small">Crea la primera con el botón “+ Nueva obra”.</p>` : html`<p class="muted small">Pide al administrador que te asigne a una obra.</p>`}</div>`}
    ${staff ? html`<button class="fab" data-action="obra-form">+ Nueva obra</button>` : ''}`.s;
  $('#filtro')?.addEventListener('input', (e) => {
    const t = e.target.value.toLowerCase();
    $('#lista').innerHTML = obras.filter((o) => `${o.nombre} ${o.codigo} ${o.ubicacion} ${o.cliente}`.toLowerCase().includes(t)).map(obraCard).join('');
  });
}
const obraCard = (o) => html`<a class="card" href="#/obra/${o.id}/resumen">
  <div class="row sp"><h3 class="grow"><span class="dot ${o.resumen.semaforo}"></span>${o.nombre}</h3>
    ${o.resumen.incidencias_abiertas ? html`<span class="pill abierta inc">⚠ ${o.resumen.incidencias_abiertas}</span>` : ''}</div>
  <div class="muted small">${[o.codigo, o.ubicacion, ESTADOS[o.estado]].filter(Boolean).join(' · ')}</div>
  <div class="row sp small" style="margin-top:8px"><span>Físico</span><b>${o.resumen.avance_fisico}%</b></div>${bar(o.resumen.avance_fisico)}
  <div class="row sp small"><span>Financiero</span><b>${o.resumen.avance_financiero}%</b></div>${bar(o.resumen.avance_financiero, 'fin')}
  ${o.resumen.desviacion !== null ? html`<div class="small muted">Plan por tiempo: ${o.resumen.avance_planificado}% · desviación ${o.resumen.desviacion > 0 ? '+' : ''}${o.resumen.desviacion} pp</div>` : ''}
</a>`;

const TABS = [['resumen', 'Resumen'], ['avance', 'Avance'], ['bitacora', 'Bitácora'], ['fotos', 'Fotos'], ['pagos', 'Pagos']];
async function viewObra(id, tab = 'resumen') {
  spinner();
  const [obra] = await Promise.all([get(`/api/obras/${id}`)]);
  setTitle(obra.nombre, '#/');
  const pend = (await idb.all('outbox').catch(() => [])).filter((x) => x.obraId === Number(id)).length;
  const head = html`<div class="tabs">${TABS.map(([k, l]) => html`<a href="#/obra/${id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`)}</div>
    ${pend ? html`<a class="card pending small" href="#/sync">⏳ ${pend} registro(s) de esta obra pendientes de enviar</a>` : ''}`;
  const body = await ({ resumen: tabResumen, avance: tabAvance, bitacora: tabBitacora, fotos: tabFotos, pagos: tabPagos }[tab] || tabResumen)(obra);
  main.innerHTML = head.s + body.s;
}
const canWrite = () => state.me.rol !== 'lector';
const isStaff = () => ['admin', 'supervisor'].includes(state.me.rol);

async function tabResumen(o) {
  const r = o.resumen;
  return html`
    <div class="kpis">
      <div class="kpi"><b>${r.avance_fisico}%</b><span>Avance físico</span>${bar(r.avance_fisico)}</div>
      <div class="kpi"><b>${r.avance_financiero}%</b><span>Avance financiero</span>${bar(r.avance_financiero, 'fin')}</div>
      <div class="kpi"><b>${r.avance_planificado ?? '–'}${r.avance_planificado === null ? '' : '%'}</b><span>Planificado (tiempo)</span></div>
      <div class="kpi"><b><span class="dot ${r.semaforo}"></span>${r.desviacion === null ? '–' : (r.desviacion > 0 ? '+' : '') + r.desviacion + ' pp'}</b><span>Desviación</span></div>
    </div>
    <div class="card"><div class="row sp"><h3>Datos</h3>${isStaff() ? html`<button class="sec sm" data-action="obra-form" data-id="${o.id}">Editar</button>` : ''}</div>
      <p class="small" style="margin:6px 0 0">${[['Código', o.codigo], ['Estado', ESTADOS[o.estado]], ['Ubicación', o.ubicacion], ['Cliente', o.cliente], ['Contratista', o.contratista],
        ['Inicio', o.fecha_inicio], ['Fin previsto', o.fecha_fin], ['Presupuesto', money(o.presupuesto)], ['Valor ejecutado', money(r.valor_ejecutado)],
        ['Pagado', money(r.pagado)], ['Incidencias abiertas', r.incidencias_abiertas], ['Fotos', r.total_fotos], ['Último avance', r.ultimo_avance || '–']]
        .filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => html`<span class="muted">${k}:</span> ${v}<br>`)}</p>
      ${o.lat != null ? html`<p><a class="btn sec sm" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${o.lat},${o.lng}">📍 Ver en mapa</a></p>` : ''}
    </div>
    <div class="card"><h3>Informe</h3>
      <div class="two"><div><label>Desde</label><input type="date" id="rdesde"></div><div><label>Hasta</label><input type="date" id="rhasta"></div></div>
      <div class="row wrap" style="margin-top:10px">
        <button class="sm" data-action="informe" data-id="${o.id}" data-fmt="">Ver / PDF</button>
        <button class="sec sm" data-action="informe" data-id="${o.id}" data-fmt=".xlsx">Excel</button></div>
      <p class="muted small">“Ver / PDF” abre el informe; usa Imprimir → Guardar como PDF.</p></div>
    <div class="card"><h3>Equipo</h3><p class="small">${o.miembros.map((m) => `${m.nombre} (${ROLES[m.rol]})`).join(', ') || 'Sin asignar'}</p>
      ${state.me.rol === 'admin' ? html`<button class="sec sm" data-action="miembros" data-id="${o.id}">Asignar personas</button>` : ''}</div>`;
}

async function tabAvance(o) {
  const [partidas, avances] = await Promise.all([get(`/api/obras/${o.id}/partidas`), get(`/api/obras/${o.id}/avances`)]);
  const staff = isStaff();
  return html`
    ${staff ? html`<div class="row wrap" style="margin-bottom:10px">
      <button class="sec sm" data-action="partida-form" data-id="${o.id}">+ Partida</button>
      <button class="sec sm" data-action="partidas-import" data-id="${o.id}">Importar desde Excel</button></div>` : ''}
    ${partidas.map((p) => html`<div class="card">
      <div class="row sp"><div class="grow"><b>${p.codigo ? p.codigo + ' · ' : ''}${p.descripcion}</b>
        <div class="muted small">${fmtNum(p.ejecutado)} / ${fmtNum(p.cantidad)} ${p.unidad} · P.U. ${money(p.precio_unit)}</div></div><b>${p.avance_pct}%</b></div>
      ${bar(p.avance_pct)}
      <div class="row wrap">${canWrite() ? html`<button class="sm" data-action="avance-form" data-id="${o.id}" data-pid="${p.id}">Registrar avance</button>` : ''}
        ${staff ? html`<button class="sec sm" data-action="partida-form" data-id="${o.id}" data-pid="${p.id}">Editar</button>
        <button class="danger sm" data-action="partida-del" data-pid="${p.id}">Eliminar</button>` : ''}</div></div>`)}
    ${partidas.length ? '' : html`<div class="card center muted">Aún no hay partidas.${staff ? ' Agrega la primera o importa el presupuesto.' : ''}</div>`}
    ${avances.length ? html`<h3>Últimos avances</h3>${avances.slice(0, 30).map((a) => html`<div class="card small">
      <div class="row sp"><b>${a.fecha}</b><span>+${fmtNum(a.cantidad)} ${a.unidad}</span></div>
      <div>${a.codigo ? a.codigo + ' · ' : ''}${a.partida}</div>
      ${a.comentario ? html`<div class="muted">${a.comentario}</div>` : ''}
      <div class="row sp muted"><span>${a.autor || ''}</span>${staff ? html`<button class="danger sm" data-action="avance-del" data-aid="${a.id}">Borrar</button>` : ''}</div></div>`)}` : ''}`;
}

async function tabBitacora(o) {
  const items = await get(`/api/obras/${o.id}/bitacora`);
  const fotos = await get(`/api/obras/${o.id}/fotos`);
  window.__fotos = Object.fromEntries(fotos.map((f) => [f.id, f]));
  const byB = {}; fotos.forEach((f) => { if (f.bitacora_id) (byB[f.bitacora_id] ||= []).push(f); });
  return html`
    <div class="row wrap" style="margin-bottom:10px">
      <select id="bfiltro" style="width:auto"><option value="">Todo</option><option value="incidencia">Incidencias</option><option value="abierta">Abiertas</option></select></div>
    <div id="blista">${items.map((b) => bitItem(b, byB[b.id] || []))}</div>
    ${items.length ? '' : html`<div class="card center muted">Sin registros todavía.</div>`}
    ${canWrite() ? html`<button class="fab" data-action="bit-form" data-id="${o.id}">+ Registro</button>` : ''}`;
}
const bitItem = (b, fotos) => html`<div class="card" data-tipo="${b.tipo}" data-estado="${b.estado}">
  <div class="row sp"><b>${b.titulo}</b><span class="pill ${b.tipo === 'incidencia' ? b.estado + ' inc' : ''}">${b.tipo === 'incidencia' ? (b.estado === 'abierta' ? '⚠ abierta' : '✓ cerrada') : b.tipo}</span></div>
  <div class="muted small">${b.fecha}${b.severidad ? ` · severidad ${b.severidad}` : ''}${b.responsable ? ` · resp.: ${b.responsable}` : ''}${b.autor ? ` · ${b.autor}` : ''}</div>
  ${b.descripcion ? html`<p style="margin:6px 0">${b.descripcion}</p>` : ''}
  ${fotos.length ? html`<div class="thumbs">${fotos.map((f) => html`<img src="/uploads/${f.archivo}" data-action="foto" data-fid="${f.id}" loading="lazy" alt="">`)}</div>` : ''}
  ${b.tipo === 'incidencia' && canWrite() ? html`<div class="row" style="margin-top:8px"><button class="sec sm" data-action="bit-estado" data-bid="${b.id}" data-estado="${b.estado === 'abierta' ? 'cerrada' : 'abierta'}">${b.estado === 'abierta' ? 'Marcar cerrada' : 'Reabrir'}</button></div>` : ''}
</div>`;

async function tabFotos(o) {
  const fotos = await get(`/api/obras/${o.id}/fotos`);
  window.__fotos = Object.fromEntries(fotos.map((f) => [f.id, f]));
  return html`<div class="gallery">${fotos.map((f) => html`<img src="/uploads/${f.archivo}" data-action="foto" data-fid="${f.id}" loading="lazy" alt="${f.descripcion || 'foto'}">`)}</div>
    ${fotos.length ? '' : html`<div class="card center muted">Aún no hay fotos.</div>`}
    ${canWrite() ? html`<button class="fab" data-action="foto-form" data-id="${o.id}">📷 Agregar fotos</button>` : ''}`;
}

async function tabPagos(o) {
  const pagos = await get(`/api/obras/${o.id}/pagos`);
  const total = pagos.reduce((s, p) => s + p.monto, 0);
  return html`<div class="kpis"><div class="kpi"><b>${money(total)}</b><span>Total pagado</span></div>
      <div class="kpi"><b>${o.resumen.avance_financiero}%</b><span>del presupuesto (${money(o.presupuesto)})</span></div></div>
    ${pagos.map((p) => html`<div class="card small"><div class="row sp"><b>${p.concepto}</b><b>${money(p.monto)}</b></div>
      <div class="row sp muted"><span>${p.fecha}</span>${isStaff() ? html`<button class="danger sm" data-action="pago-del" data-pid="${p.id}">Borrar</button>` : ''}</div></div>`)}
    ${pagos.length ? '' : html`<div class="card center muted">Sin pagos registrados.</div>`}
    ${isStaff() ? html`<button class="fab" data-action="pago-form" data-id="${o.id}">+ Pago</button>` : ''}`;
}

async function viewSync() {
  setTitle('Pendientes de enviar', '#/');
  const items = (await idb.all('outbox')).sort((a, b) => a.id - b.id);
  main.innerHTML = html`
    <div class="card small">Los registros hechos sin conexión se guardan en el teléfono y se envían solos al volver internet.</div>
    ${items.map((it) => html`<div class="card pending small"><div class="row sp"><b>${it.label || it.kind}</b><span class="muted">${fmtDT(it.creado)}</span></div>
      ${it.error ? html`<div class="err">Rechazado: ${it.error}</div>` : html`<div class="muted">Esperando conexión…</div>`}
      <div class="row">${it.error ? html`<button class="sec sm" data-action="outbox-retry" data-oid="${it.id}">Reintentar</button>` : ''}
      <button class="danger sm" data-action="outbox-del" data-oid="${it.id}">Descartar</button></div></div>`)}
    ${items.length ? html`<button data-action="sync-now" style="width:100%">Enviar ahora</button>` : html`<div class="card center muted">Todo está sincronizado ✓</div>`}`.s;
}

async function viewAdmin() {
  if (state.me.rol !== 'admin') { location.hash = '#/'; return; }
  setTitle('Usuarios', '#/'); spinner();
  const users = await get('/api/users');
  main.innerHTML = html`${users.map((u) => html`<div class="card"><div class="row sp"><div class="grow"><b>${u.nombre}</b>
      <div class="muted small">${u.email}</div></div><span class="pill">${ROLES[u.rol]}${u.activo ? '' : ' · inactivo'}</span></div>
      <button class="sec sm" data-action="user-form" data-uid="${u.id}">Editar</button></div>`)}
    <button class="fab" data-action="user-form">+ Usuario</button>`.s;
  window.__users = Object.fromEntries(users.map((u) => [u.id, u]));
}

// ---------- formularios (hojas) ----------
const val = (f, n) => f.elements[n]?.value ?? '';
const roleOptions = (sel) => Object.entries(ROLES).map(([k, v]) => html`<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`);

const actions = {
  reload: () => route(),
  'sync-now': async () => { await flush(); route(); },
  pick: (el) => pickFiles(el.dataset.id, el.dataset.cam),

  'obra-form': async (el) => {
    const o = el.dataset.id ? await get(`/api/obras/${el.dataset.id}`) : {};
    openSheet(html`<h2>${o.id ? 'Editar obra' : 'Nueva obra'}</h2><form data-form="obra" data-id="${o.id || ''}">
      <label>Nombre *</label><input name="nombre" required value="${o.nombre || ''}">
      <div class="two"><div><label>Código</label><input name="codigo" value="${o.codigo || ''}"></div>
        <div><label>Estado</label><select name="estado">${Object.entries(ESTADOS).map(([k, v]) => html`<option value="${k}" ${k === (o.estado || 'en_ejecucion') ? 'selected' : ''}>${v}</option>`)}</select></div></div>
      <label>Ubicación</label><input name="ubicacion" value="${o.ubicacion || ''}">
      <div class="two"><div><label>Cliente</label><input name="cliente" value="${o.cliente || ''}"></div>
        <div><label>Contratista</label><input name="contratista" value="${o.contratista || ''}"></div></div>
      <div class="two"><div><label>Inicio</label><input type="date" name="fecha_inicio" value="${o.fecha_inicio || ''}"></div>
        <div><label>Fin previsto</label><input type="date" name="fecha_fin" value="${o.fecha_fin || ''}"></div></div>
      <label>Presupuesto</label><input name="presupuesto" type="number" step="any" min="0" inputmode="decimal" value="${o.presupuesto || ''}">
      <div class="two"><div><label>Latitud</label><input name="lat" type="number" step="any" value="${o.lat ?? ''}"></div>
        <div><label>Longitud</label><input name="lng" type="number" step="any" value="${o.lng ?? ''}"></div></div>
      <button type="button" class="sec sm" data-action="use-gps" style="margin-top:8px">📍 Usar mi ubicación</button>
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s);
  },
  'use-gps': async (el) => {
    el.textContent = 'Buscando…'; const p = await getPosition();
    if (p) { const f = el.closest('form'); f.elements.lat.value = p.lat.toFixed(6); f.elements.lng.value = p.lng.toFixed(6); el.textContent = '📍 Ubicación obtenida'; }
    else { el.textContent = '📍 No se pudo (¿HTTPS y permiso?)'; }
  },
  close: closeSheet,

  informe: (el) => {
    const q = new URLSearchParams(); const d = $('#rdesde').value, h = $('#rhasta').value;
    if (d) q.set('desde', d); if (h) q.set('hasta', h);
    window.open(`/api/obras/${el.dataset.id}/informe${el.dataset.fmt}?${q}`, '_blank');
  },

  miembros: async (el) => {
    const [users, o] = await Promise.all([get('/api/users'), get(`/api/obras/${el.dataset.id}`)]);
    const ids = new Set(o.miembros.map((m) => m.id));
    openSheet(html`<h2>Equipo de la obra</h2><form data-form="miembros" data-id="${o.id}">
      ${users.filter((u) => u.activo).map((u) => html`<label class="row" style="color:var(--text)"><input type="checkbox" style="width:24px;min-height:24px" name="u" value="${u.id}" ${ids.has(u.id) ? 'checked' : ''}> ${u.nombre} <span class="muted small">(${ROLES[u.rol]})</span></label>`)}
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s);
  },

  'partida-form': async (el) => {
    let p = {};
    if (el.dataset.pid) p = (await get(`/api/obras/${el.dataset.id}/partidas`)).find((x) => x.id === Number(el.dataset.pid)) || {};
    openSheet(html`<h2>${p.id ? 'Editar partida' : 'Nueva partida'}</h2><form data-form="partida" data-id="${el.dataset.id}" data-pid="${p.id || ''}">
      <div class="two"><div><label>Código</label><input name="codigo" value="${p.codigo || ''}"></div><div><label>Unidad</label><input name="unidad" value="${p.unidad || 'm2'}"></div></div>
      <label>Descripción *</label><input name="descripcion" required value="${p.descripcion || ''}">
      <div class="two"><div><label>Metrado *</label><input name="cantidad" type="number" step="any" min="0" required inputmode="decimal" value="${p.cantidad ?? ''}"></div>
        <div><label>Precio unitario</label><input name="precio_unit" type="number" step="any" min="0" inputmode="decimal" value="${p.precio_unit ?? ''}"></div></div>
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s);
  },
  'partidas-import': (el) => openSheet(html`<h2>Importar partidas</h2>
    <p class="muted small">Copia filas desde Excel con las columnas: <b>código, descripción, unidad, metrado, precio unitario</b> (separadas por tabulador o punto y coma) y pégalas aquí.</p>
    <form data-form="import" data-id="${el.dataset.id}"><textarea name="texto" rows="8" required placeholder="01.01&#9;Excavación&#9;m3&#9;120&#9;35.50"></textarea>
    <p class="err" id="err"></p><div class="row"><button class="grow">Importar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s),
  'partida-del': async (el) => {
    if (!confirm('¿Eliminar la partida y sus avances registrados?')) return;
    await api('DELETE', `/api/partidas/${el.dataset.pid}`); route();
  },

  'avance-form': async (el) => {
    const o = await get(`/api/obras/${el.dataset.id}`);
    const p = (await get(`/api/obras/${el.dataset.id}/partidas`)).find((x) => x.id === Number(el.dataset.pid));
    openSheet(html`<h2>Registrar avance</h2><p class="muted small">${p.codigo ? p.codigo + ' · ' : ''}${p.descripcion}<br>Ejecutado ${fmtNum(p.ejecutado)} de ${fmtNum(p.cantidad)} ${p.unidad}</p>
      <form data-form="avance" data-id="${o.id}" data-pid="${p.id}">
      <div class="two"><div><label>Cantidad hoy (${p.unidad}) *</label><input name="cantidad" type="number" step="any" min="0" required inputmode="decimal" autofocus></div>
        <div><label>Fecha</label><input name="fecha" type="date" value="${today()}" required></div></div>
      <label>Comentario</label><textarea name="comentario" rows="2"></textarea>
      ${photoPicker('avance')}
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s);
  },
  'avance-del': async (el) => { if (confirm('¿Borrar este avance?')) { await api('DELETE', `/api/avances/${el.dataset.aid}`); route(); } },

  'bit-form': (el) => openSheet(html`<h2>Nuevo registro</h2><form data-form="bitacora" data-id="${el.dataset.id}">
      <div class="two"><div><label>Tipo</label><select name="tipo" data-change="bit-tipo"><option value="nota">Nota del día</option><option value="visita">Visita</option><option value="incidencia">Incidencia</option></select></div>
        <div><label>Fecha</label><input name="fecha" type="date" value="${today()}" required></div></div>
      <label>Título *</label><input name="titulo" required maxlength="200">
      <label>Detalle</label><textarea name="descripcion" rows="3"></textarea>
      <div id="inc-extra" hidden><div class="two"><div><label>Severidad</label><select name="severidad"><option value="baja">Baja</option><option value="media" selected>Media</option><option value="alta">Alta</option></select></div>
        <div><label>Responsable</label><input name="responsable"></div></div></div>
      ${photoPicker('bit')}
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s),
  'bit-estado': async (el) => { await api('PUT', `/api/bitacora/${el.dataset.bid}`, { estado: el.dataset.estado }); route(); },

  'foto-form': (el) => openSheet(html`<h2>Agregar fotos</h2><form data-form="fotos" data-id="${el.dataset.id}">
      <p class="muted small">Se les estampa fecha, hora y GPS (si das permiso de ubicación).</p>
      ${photoPicker('fotos')}<label>Descripción</label><input name="descripcion" maxlength="500">
      <p class="err" id="err"></p><div class="row"><button class="grow">Subir</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s),
  foto: (el) => {
    const f = window.__fotos?.[el.dataset.fid];
    const src = el.getAttribute('src');
    openSheet(html`<div class="viewer"><img src="${src}" alt="">
      <p class="small">${f ? fmtDT(f.tomada_en) : ''}${f?.autor ? ` · ${f.autor}` : ''}<br>${f?.descripcion || ''}
      ${f?.lat != null ? html`<br><a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${f.lat},${f.lng}">📍 ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}</a>` : ''}</p>
      <div class="row">${f && isStaff() ? html`<button class="danger sm" data-action="foto-del" data-fid="${f.id}">Eliminar</button>` : ''}<button class="sec grow" data-action="close">Cerrar</button></div></div>`.s);
  },
  'foto-del': async (el) => { if (confirm('¿Eliminar la foto?')) { await api('DELETE', `/api/fotos/${el.dataset.fid}`); closeSheet(); route(); } },

  'pago-form': (el) => openSheet(html`<h2>Registrar pago / valorización</h2><form data-form="pago" data-id="${el.dataset.id}">
      <label>Concepto *</label><input name="concepto" required maxlength="300" placeholder="Valorización N° 1">
      <div class="two"><div><label>Monto *</label><input name="monto" type="number" step="any" required inputmode="decimal"></div>
        <div><label>Fecha</label><input name="fecha" type="date" value="${today()}" required></div></div>
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s),
  'pago-del': async (el) => { if (confirm('¿Borrar este pago?')) { await api('DELETE', `/api/pagos/${el.dataset.pid}`); route(); } },

  'user-form': (el) => {
    const u = el.dataset.uid ? window.__users[el.dataset.uid] : {};
    openSheet(html`<h2>${u.id ? 'Editar usuario' : 'Nuevo usuario'}</h2><form data-form="user" data-uid="${u.id || ''}">
      <label>Nombre *</label><input name="nombre" required value="${u.nombre || ''}">
      <label>Correo *</label><input name="email" type="email" required value="${u.email || ''}" ${u.id ? 'disabled' : ''}>
      <label>Rol</label><select name="rol">${roleOptions(u.rol || 'residente')}</select>
      <label>${u.id ? 'Nueva contraseña (opcional)' : 'Contraseña * (mín. 8)'}</label><input name="password" type="password" minlength="8" ${u.id ? '' : 'required'} autocomplete="new-password">
      ${u.id ? html`<label class="row" style="color:var(--text)"><input type="checkbox" name="activo" style="width:24px;min-height:24px" ${u.activo ? 'checked' : ''}> Activo</label>` : ''}
      <p class="err" id="err"></p><div class="row"><button class="grow">Guardar</button><button type="button" class="sec" data-action="close">Cancelar</button></div></form>`.s);
  },

  'outbox-del': async (el) => { await idb.del('outbox', Number(el.dataset.oid)); updateBadge(); viewSync(); },
  'outbox-retry': async (el) => {
    const it = await idb.get('outbox', Number(el.dataset.oid)); await idb.put('outbox', { ...it, error: null });
    await flush(); viewSync();
  },
  menu: () => openSheet(html`<h2>${state.me.nombre}</h2><p class="muted small">${ROLES[state.me.rol]} · ${state.me.email}</p>
    <div style="display:grid;gap:8px">
      <a class="btn sec" href="#/" data-action="close">Mis obras</a>
      <a class="btn sec" href="#/sync" data-action="close">Pendientes de enviar</a>
      ${state.me.rol === 'admin' ? html`<a class="btn sec" href="#/admin" data-action="close">Usuarios</a>` : ''}
      <button class="danger" data-action="logout">Cerrar sesión</button></div>`.s),
  logout: async () => {
    const pend = (await idb.all('outbox')).length;
    if (pend && !confirm(`Hay ${pend} registro(s) sin enviar que se perderán. ¿Cerrar sesión igual?`)) return;
    await api('POST', '/api/logout', {}).catch(() => {});
    await Promise.all([idb.clear('cache'), idb.clear('outbox')]).catch(() => {});
    navigator.serviceWorker?.controller?.postMessage('clear-private');
    state.me = null; closeSheet(); updateBadge(); location.hash = '#/login'; route();
  },
};

// ---------- envío de formularios ----------
const forms = {
  async setup(f) { state.me = await api('POST', '/api/setup', { nombre: val(f, 'nombre'), email: val(f, 'email'), password: val(f, 'password') }); location.hash = '#/'; },
  async login(f) { state.me = await api('POST', '/api/login', { email: val(f, 'email'), password: val(f, 'password') }); location.hash = '#/'; flush(); },
  async obra(f) {
    const b = Object.fromEntries(new FormData(f));
    const id = f.dataset.id;
    const o = await api(id ? 'PUT' : 'POST', id ? `/api/obras/${id}` : '/api/obras', b);
    closeSheet(); location.hash = `#/obra/${o.id}/resumen`; route();
  },
  async miembros(f) {
    await api('PUT', `/api/obras/${f.dataset.id}/miembros`, { user_ids: [...f.querySelectorAll('input[name=u]:checked')].map((i) => Number(i.value)) });
    closeSheet(); route();
  },
  async partida(f) {
    const b = { codigo: val(f, 'codigo'), unidad: val(f, 'unidad'), descripcion: val(f, 'descripcion'), cantidad: val(f, 'cantidad'), precio_unit: val(f, 'precio_unit') };
    if (f.dataset.pid) await api('PUT', `/api/partidas/${f.dataset.pid}`, b); else await api('POST', `/api/obras/${f.dataset.id}/partidas`, b);
    closeSheet(); route();
  },
  async import(f) {
    const num = (s) => Number(String(s).trim().replace(/\s/g, '').replace(/,(\d{1,3})$/, '.$1').replace(/,/g, ''));
    const rows = val(f, 'texto').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\t|;/).map((c) => c.trim()));
    const data = rows.filter((c) => c.length >= 4 && !Number.isNaN(num(c[3]))).map((c) => ({ codigo: c[0], descripcion: c[1], unidad: c[2], cantidad: num(c[3]), precio_unit: c[4] ? num(c[4]) || 0 : 0 }));
    if (!data.length) throw new Error('No se reconocieron filas. Usa: código, descripción, unidad, metrado, precio.');
    const r = await api('POST', `/api/obras/${f.dataset.id}/partidas`, data);
    toast(`${r.creadas} partida(s) importada(s)`); closeSheet(); route();
  },
  async avance(f) {
    const obra = await get(`/api/obras/${f.dataset.id}`);
    const uuid = uid();
    const r = await send('avance', f.dataset.id, { partida_id: Number(f.dataset.pid), cantidad: val(f, 'cantidad'), fecha: val(f, 'fecha'), comentario: val(f, 'comentario'), client_uuid: uuid }, `Avance – ${obra.nombre}`);
    const q = await sendPhotos('avance', f.dataset.id, obra, { partida_id: Number(f.dataset.pid), descripcion: val(f, 'comentario') });
    toast(r.queued || q ? 'Guardado en el teléfono; se enviará al volver la conexión' : 'Avance registrado');
    closeSheet(); route();
  },
  async bitacora(f) {
    const obra = await get(`/api/obras/${f.dataset.id}`);
    const uuid = uid();
    const r = await send('bitacora', f.dataset.id, { tipo: val(f, 'tipo'), fecha: val(f, 'fecha'), titulo: val(f, 'titulo'), descripcion: val(f, 'descripcion'),
      severidad: val(f, 'severidad'), responsable: val(f, 'responsable'), client_uuid: uuid }, `${val(f, 'tipo')} – ${val(f, 'titulo')}`);
    const q = await sendPhotos('bit', f.dataset.id, obra, { bitacora_uuid: uuid });
    toast(r.queued || q ? 'Guardado en el teléfono; se enviará al volver la conexión' : 'Registro guardado');
    closeSheet(); route();
  },
  async fotos(f) {
    if (!picked.fotos.length) throw new Error('Selecciona al menos una foto');
    const obra = await get(`/api/obras/${f.dataset.id}`);
    const q = await sendPhotos('fotos', f.dataset.id, obra, { descripcion: val(f, 'descripcion') });
    toast(q ? 'Fotos guardadas en el teléfono; se enviarán al volver la conexión' : 'Fotos subidas');
    closeSheet(); route();
  },
  async pago(f) {
    const r = await send('pago', f.dataset.id, { concepto: val(f, 'concepto'), monto: val(f, 'monto'), fecha: val(f, 'fecha') }, `Pago – ${val(f, 'concepto')}`);
    toast(r.queued ? 'Guardado en el teléfono; se enviará al volver la conexión' : 'Pago registrado'); closeSheet(); route();
  },
  async user(f) {
    const b = { nombre: val(f, 'nombre'), email: val(f, 'email'), rol: val(f, 'rol') };
    if (val(f, 'password')) b.password = val(f, 'password');
    if (f.dataset.uid) { b.activo = f.elements.activo.checked; await api('PUT', `/api/users/${f.dataset.uid}`, b); }
    else await api('POST', '/api/users', b);
    closeSheet(); route();
  },
};

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button:not([type])'); const err = $('#err', f.closest('#sheet') || document);
  if (btn) btn.disabled = true; if (err) err.textContent = '';
  try { await forms[f.dataset.form](f); }
  catch (ex) { if (err) err.textContent = ex.message; else toast(ex.message); if (btn) btn.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const fn = actions[el.dataset.action]; if (!fn) return;
  if (el.tagName === 'A' && el.dataset.action === 'close') { closeSheet(); return; } // el href navega
  e.preventDefault();
  try { await fn(el); } catch (ex) { toast(ex.message); }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset?.change === 'bit-tipo') $('#inc-extra').hidden = e.target.value !== 'incidencia';
  if (e.target.id === 'bfiltro') {
    const v = e.target.value;
    document.querySelectorAll('#blista [data-tipo]').forEach((c) => {
      c.hidden = (v === 'incidencia' && c.dataset.tipo !== 'incidencia') || (v === 'abierta' && !(c.dataset.tipo === 'incidencia' && c.dataset.estado === 'abierta'));
    });
  }
});
$('#back').addEventListener('click', (e) => { location.hash = e.currentTarget.dataset.href || '#/'; });
$('#menu').addEventListener('click', () => actions.menu());

// ---------- enrutador ----------
async function route() {
  closeSheet();
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  try {
    if (!state.me) {
      try { state.me = await get('/api/me'); } catch (e) { if (!(e instanceof ApiError)) throw e; }
      if (!state.me) { if (parts[0] !== 'login') location.hash = '#/login'; return viewLogin(); }
    }
    if (parts[0] === 'login') { location.hash = '#/'; return; }
    updateBadge();
    if (parts[0] === 'obra' && parts[1]) return await viewObra(parts[1], parts[2]);
    if (parts[0] === 'sync') return await viewSync();
    if (parts[0] === 'admin') return await viewAdmin();
    return await viewObras();
  } catch (e) { setTitle('Obras'); showError(e); }
}
window.addEventListener('hashchange', route);
window.addEventListener('online', () => { flush(); });
setInterval(() => { flush(); }, 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route().then(() => flush());
