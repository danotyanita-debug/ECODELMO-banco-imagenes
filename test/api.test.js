'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obras-test-'));
process.env.DATA_DIR = tmp;
const { open } = require('../server/db');
const { createApp } = require('../server/index');

let server, base;
const jars = {};
async function call(who, method, url, body, { raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jars[who]) headers.Cookie = jars[who];
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) jars[who] = sc.split(';')[0];
  if (raw) return r;
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch {}
  return { status: r.status, json, txt };
}

before(async () => {
  const db = open(path.join(tmp, 't.db'));
  server = http.createServer(createApp(db).handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// JPEG mínimo válido (1x1)
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('requiere configuración inicial y sesión', async () => {
  assert.equal((await call('a', 'GET', '/api/status')).json.needsSetup, true);
  assert.equal((await call('a', 'GET', '/api/obras')).status, 401);
  assert.equal((await call('a', 'POST', '/api/setup', { nombre: 'Ana', email: 'ana@x.com', password: 'corta' })).status, 400);
  const r = await call('a', 'POST', '/api/setup', { nombre: 'Ana', email: 'ana@x.com', password: 'clave-larga-1' });
  assert.equal(r.status, 200); assert.equal(r.json.rol, 'admin');
  assert.equal((await call('a', 'POST', '/api/setup', { nombre: 'X', email: 'x@x.com', password: 'clave-larga-1' })).status, 403);
});

test('flujo completo de obra, avances, pagos, bitácora y fotos', async () => {
  const o = (await call('a', 'POST', '/api/obras', { nombre: 'Colegio', presupuesto: 1000, fecha_inicio: '2025-01-01', fecha_fin: '2025-12-31' })).json;
  assert.ok(o.id);
  const pr = await call('a', 'POST', `/api/obras/${o.id}/partidas`, [
    { codigo: '01', descripcion: 'Excavación', unidad: 'm3', cantidad: 100, precio_unit: 5 },
    { codigo: '02', descripcion: 'Concreto', unidad: 'm3', cantidad: 50, precio_unit: 10 }]);
  assert.equal(pr.json.creadas, 2);
  const partidas = (await call('a', 'GET', `/api/obras/${o.id}/partidas`)).json;
  const av = { partida_id: partidas[0].id, cantidad: 50, fecha: '2025-03-01', client_uuid: 'uuid-1234-abcd' };
  const a1 = await call('a', 'POST', `/api/obras/${o.id}/avances`, av);
  const a2 = await call('a', 'POST', `/api/obras/${o.id}/avances`, av);
  assert.equal(a1.json.id, a2.json.id); assert.equal(a2.json.duplicado, true);
  // total 1000 (500+500); ejecutado 250 => 25 %
  let det = (await call('a', 'GET', `/api/obras/${o.id}`)).json;
  assert.equal(det.resumen.avance_fisico, 25);
  await call('a', 'POST', `/api/obras/${o.id}/pagos`, { fecha: '2025-03-02', concepto: 'Adelanto', monto: 100 });
  const b = (await call('a', 'POST', `/api/obras/${o.id}/bitacora`, { fecha: '2025-03-02', tipo: 'incidencia', titulo: 'Lluvia', severidad: 'alta' })).json;
  det = (await call('a', 'GET', `/api/obras/${o.id}`)).json;
  assert.equal(det.resumen.avance_financiero, 10);
  assert.equal(det.resumen.incidencias_abiertas, 1);
  await call('a', 'PUT', `/api/bitacora/${b.id}`, { estado: 'cerrada' });
  assert.equal((await call('a', 'GET', `/api/obras/${o.id}`)).json.resumen.incidencias_abiertas, 0);

  const f = await call('a', 'POST', `/api/obras/${o.id}/fotos`, { data: JPG, lat: -16.5, lng: -68.1, tomada_en: new Date().toISOString(), bitacora_id: b.id });
  assert.equal(f.status, 200, f.txt);
  const img = await call('a', 'GET', `/uploads/${f.json.archivo}`, undefined, { raw: true });
  assert.equal(img.status, 200);
  assert.equal((await call('a', 'POST', `/api/obras/${o.id}/fotos`, { data: 'data:image/jpeg;base64,AAAA' })).status, 400);

  const html = await call('a', 'GET', `/api/obras/${o.id}/informe`);
  assert.match(html.txt, /Informe de seguimiento – Colegio/);
  const x = await call('a', 'GET', `/api/obras/${o.id}/informe.xlsx`, undefined, { raw: true });
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('roles y pertenencia a obras', async () => {
  const obras = (await call('a', 'GET', '/api/obras')).json;
  const oid = obras[0].id;
  const mk = (rol, email) => call('a', 'POST', '/api/users', { nombre: rol, email, password: 'clave-larga-1', rol });
  const res = (await mk('residente', 'r@x.com')).json;
  const lec = (await mk('lector', 'l@x.com')).json;
  await call('r', 'POST', '/api/login', { email: 'r@x.com', password: 'clave-larga-1' });
  await call('l', 'POST', '/api/login', { email: 'l@x.com', password: 'clave-larga-1' });
  // sin asignar no ve la obra
  assert.equal((await call('r', 'GET', '/api/obras')).json.length, 0);
  assert.equal((await call('r', 'GET', `/api/obras/${oid}`)).status, 404);
  await call('a', 'PUT', `/api/obras/${oid}/miembros`, { user_ids: [res.id, lec.id] });
  assert.equal((await call('r', 'GET', '/api/obras')).json.length, 1);
  const p = (await call('r', 'GET', `/api/obras/${oid}/partidas`)).json[1];
  assert.equal((await call('r', 'POST', `/api/obras/${oid}/avances`, { partida_id: p.id, cantidad: 5, fecha: '2025-03-03' })).status, 200);
  // el residente no puede registrar pagos ni editar la obra; el lector no escribe
  assert.equal((await call('r', 'POST', `/api/obras/${oid}/pagos`, { fecha: '2025-03-03', concepto: 'x', monto: 1 })).status, 403);
  assert.equal((await call('r', 'PUT', `/api/obras/${oid}`, { nombre: 'Otro' })).status, 403);
  assert.equal((await call('l', 'POST', `/api/obras/${oid}/avances`, { partida_id: p.id, cantidad: 5, fecha: '2025-03-03' })).status, 403);
  assert.equal((await call('r', 'GET', '/api/users')).status, 403);
  // contraseña incorrecta
  assert.equal((await call('x', 'POST', '/api/login', { email: 'r@x.com', password: 'mala' })).status, 401);
});

test('no sirve archivos fuera de public ni acepta formularios', async () => {
  const r = await fetch(base + '/..%2Fserver%2Fauth.js');
  assert.notEqual(r.status, 200);
  const f = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(f.status, 415);
});
