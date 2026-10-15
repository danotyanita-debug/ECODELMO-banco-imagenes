'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { open, UPLOAD_DIR } = require('./db');
const auth = require('./auth');
const { resumenObra, partidasConAvance } = require('./metrics');
const report = require('./report');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 15 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const ROLES = ['admin', 'supervisor', 'residente', 'lector'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

// ---------- validación ----------
const str = (v, { max = 500, req = false, name = 'campo' } = {}) => {
  if (v === undefined || v === null || v === '') { if (req) throw bad(`Falta ${name}`); return null; }
  const s = String(v).trim();
  if (req && !s) throw bad(`Falta ${name}`);
  if (s.length > max) throw bad(`${name} demasiado largo`);
  return s || null;
};
const num = (v, { req = false, min = -Infinity, max = Infinity, name = 'número' } = {}) => {
  if (v === undefined || v === null || v === '') { if (req) throw bad(`Falta ${name}`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} inválido`);
  return n;
};
const date = (v, { req = false, name = 'fecha' } = {}) => {
  if (v === undefined || v === null || v === '') { if (req) throw bad(`Falta ${name}`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(v)) || Number.isNaN(Date.parse(v))) throw bad(`${name} inválida`);
  return String(v).slice(0, 10);
};
const oneOf = (v, list, def, name) => {
  if (v === undefined || v === null || v === '') return def;
  if (!list.includes(v)) throw bad(`${name} inválido`);
  return v;
};
const uuid = (v) => (v && /^[\w-]{8,64}$/.test(String(v)) ? String(v) : null);

function createApp(db) {
  const q = {
    userById: db.prepare('SELECT id, nombre, email, rol, activo FROM users WHERE id = ?'),
    obra: db.prepare('SELECT * FROM obras WHERE id = ?'),
    miembro: db.prepare('SELECT 1 FROM obra_miembros WHERE obra_id = ? AND user_id = ?'),
  };

  // ---------- permisos ----------
  const isStaff = (u) => u.rol === 'admin' || u.rol === 'supervisor';
  function obraFor(user, id, { write = false, staff = false } = {}) {
    const obra = q.obra.get(Number(id));
    if (!obra) throw new HttpError(404, 'Obra no encontrada');
    if (user.rol !== 'admin' && !q.miembro.get(obra.id, user.id)) throw new HttpError(404, 'Obra no encontrada');
    if (write && user.rol === 'lector') throw new HttpError(403, 'Tu usuario es de solo lectura');
    if (staff && !isStaff(user)) throw new HttpError(403, 'Requiere rol supervisor o administrador');
    return obra;
  }
  const needAdmin = (u) => { if (u.rol !== 'admin') throw new HttpError(403, 'Solo administradores'); };

  function withIdempotency(table, uid, insert) {
    if (uid) {
      const prev = db.prepare(`SELECT * FROM ${table} WHERE client_uuid = ?`).get(uid);
      if (prev) return { row: prev, dup: true };
    }
    return { row: insert(), dup: false };
  }

  // ---------- rutas ----------
  // Cada ruta: [método, regex, handler(ctx)] ; ctx = {user, params, body, query, req, res}
  const routes = [];
  const R = (method, pattern, handler, { open: isOpen = false } = {}) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, handler, isOpen });
  };

  // --- sesión ---
  R('GET', '/api/status', () => ({ needsSetup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0 }), { open: true });
  R('POST', '/api/setup', ({ body, res }) => {
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) throw new HttpError(403, 'Ya está configurado');
    const pw = str(body.password, { req: true, max: 200, name: 'contraseña' });
    if (pw.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
    const id = db.prepare('INSERT INTO users (nombre,email,pass_hash,rol) VALUES (?,?,?,?)')
      .run(str(body.nombre, { req: true, name: 'nombre' }), str(body.email, { req: true, name: 'correo' }).toLowerCase(), auth.hashPassword(pw), 'admin').lastInsertRowid;
    setSession(res, Number(id));
    return q.userById.get(id);
  }, { open: true });
  R('POST', '/api/login', ({ body, res, req }) => {
    const ip = req.socket.remoteAddress;
    if (!auth.loginAllowed(ip)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND activo = 1').get(String(body.email || '').trim().toLowerCase());
    if (!u || !auth.verifyPassword(String(body.password || ''), u.pass_hash)) {
      auth.loginFailed(ip);
      throw new HttpError(401, 'Correo o contraseña incorrectos');
    }
    auth.loginOk(ip);
    setSession(res, u.id);
    return q.userById.get(u.id);
  }, { open: true });
  R('POST', '/api/logout', ({ res }) => { res.setHeader('Set-Cookie', cookie('', 0)); return { ok: true }; }, { open: true });
  R('GET', '/api/me', ({ user }) => user);

  // --- usuarios (admin) ---
  R('GET', '/api/users', ({ user }) => {
    if (!isStaff(user)) throw new HttpError(403, 'No autorizado');
    return db.prepare('SELECT id, nombre, email, rol, activo FROM users ORDER BY nombre').all();
  });
  R('POST', '/api/users', ({ user, body }) => {
    needAdmin(user);
    const pw = str(body.password, { req: true, max: 200, name: 'contraseña' });
    if (pw.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
    try {
      const id = db.prepare('INSERT INTO users (nombre,email,pass_hash,rol) VALUES (?,?,?,?)').run(
        str(body.nombre, { req: true, name: 'nombre' }), str(body.email, { req: true, name: 'correo' }).toLowerCase(),
        auth.hashPassword(pw), oneOf(body.rol, ROLES, 'residente', 'rol')).lastInsertRowid;
      return q.userById.get(id);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Ese correo ya existe'); throw e; }
  });
  R('PUT', '/api/users/:id', ({ user, body, params }) => {
    needAdmin(user);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!u) throw new HttpError(404, 'Usuario no encontrado');
    const rol = oneOf(body.rol, ROLES, u.rol, 'rol');
    const activo = body.activo === undefined ? u.activo : body.activo ? 1 : 0;
    if (u.id === user.id && (rol !== 'admin' || !activo)) throw bad('No puedes quitarte el rol de administrador ni desactivarte');
    const hash = body.password ? (String(body.password).length >= 8 ? auth.hashPassword(String(body.password)) : (() => { throw bad('La contraseña debe tener al menos 8 caracteres'); })()) : u.pass_hash;
    db.prepare('UPDATE users SET nombre=?, rol=?, activo=?, pass_hash=? WHERE id=?')
      .run(str(body.nombre, { max: 200 }) || u.nombre, rol, activo, hash, u.id);
    return q.userById.get(u.id);
  });

  // --- obras ---
  const obraFields = (b, prev = {}) => ({
    codigo: str(b.codigo, { max: 50 }) ?? prev.codigo ?? null,
    nombre: str(b.nombre ?? prev.nombre, { req: true, max: 200, name: 'nombre' }),
    ubicacion: b.ubicacion !== undefined ? str(b.ubicacion, { max: 300 }) : prev.ubicacion ?? null,
    cliente: b.cliente !== undefined ? str(b.cliente, { max: 200 }) : prev.cliente ?? null,
    contratista: b.contratista !== undefined ? str(b.contratista, { max: 200 }) : prev.contratista ?? null,
    fecha_inicio: b.fecha_inicio !== undefined ? date(b.fecha_inicio, { name: 'fecha de inicio' }) : prev.fecha_inicio ?? null,
    fecha_fin: b.fecha_fin !== undefined ? date(b.fecha_fin, { name: 'fecha de fin' }) : prev.fecha_fin ?? null,
    presupuesto: b.presupuesto !== undefined ? num(b.presupuesto, { min: 0, name: 'presupuesto' }) ?? 0 : prev.presupuesto ?? 0,
    estado: oneOf(b.estado, ['planificada', 'en_ejecucion', 'paralizada', 'terminada'], prev.estado || 'en_ejecucion', 'estado'),
    lat: b.lat !== undefined ? num(b.lat, { min: -90, max: 90, name: 'latitud' }) : prev.lat ?? null,
    lng: b.lng !== undefined ? num(b.lng, { min: -180, max: 180, name: 'longitud' }) : prev.lng ?? null,
  });
  R('GET', '/api/obras', ({ user }) => {
    const rows = user.rol === 'admin'
      ? db.prepare('SELECT * FROM obras ORDER BY nombre').all()
      : db.prepare('SELECT o.* FROM obras o JOIN obra_miembros m ON m.obra_id = o.id WHERE m.user_id = ? ORDER BY o.nombre').all(user.id);
    return rows.map((o) => ({ ...o, resumen: resumenObra(db, o) }));
  });
  R('POST', '/api/obras', ({ user, body }) => {
    if (!isStaff(user)) throw new HttpError(403, 'Requiere rol supervisor o administrador');
    const f = obraFields(body);
    const id = db.prepare(`INSERT INTO obras (codigo,nombre,ubicacion,cliente,contratista,fecha_inicio,fecha_fin,presupuesto,estado,lat,lng)
      VALUES (@codigo,@nombre,@ubicacion,@cliente,@contratista,@fecha_inicio,@fecha_fin,@presupuesto,@estado,@lat,@lng)`).run(f).lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO obra_miembros VALUES (?,?)').run(id, user.id);
    return q.obra.get(id);
  });
  R('GET', '/api/obras/:id', ({ user, params }) => {
    const o = obraFor(user, params.id);
    const miembros = db.prepare('SELECT u.id, u.nombre, u.rol FROM obra_miembros m JOIN users u ON u.id = m.user_id WHERE m.obra_id = ? ORDER BY u.nombre').all(o.id);
    return { ...o, resumen: resumenObra(db, o), miembros };
  });
  R('PUT', '/api/obras/:id', ({ user, params, body }) => {
    const o = obraFor(user, params.id, { write: true, staff: true });
    const f = obraFields(body, o);
    db.prepare(`UPDATE obras SET codigo=@codigo,nombre=@nombre,ubicacion=@ubicacion,cliente=@cliente,contratista=@contratista,
      fecha_inicio=@fecha_inicio,fecha_fin=@fecha_fin,presupuesto=@presupuesto,estado=@estado,lat=@lat,lng=@lng WHERE id=${o.id}`).run(f);
    return q.obra.get(o.id);
  });
  R('PUT', '/api/obras/:id/miembros', ({ user, params, body }) => {
    needAdmin(user);
    const o = obraFor(user, params.id);
    const ids = Array.isArray(body.user_ids) ? body.user_ids.map(Number).filter(Number.isInteger) : [];
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM obra_miembros WHERE obra_id = ?').run(o.id);
      for (const uid of ids) if (q.userById.get(uid)) db.prepare('INSERT OR IGNORE INTO obra_miembros VALUES (?,?)').run(o.id, uid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  });

  // --- partidas ---
  const partidaFields = (b) => ({
    codigo: str(b.codigo, { max: 50 }),
    descripcion: str(b.descripcion, { req: true, max: 300, name: 'descripción' }),
    unidad: str(b.unidad, { max: 20 }) || 'glb',
    cantidad: num(b.cantidad, { req: true, min: 0, name: 'metrado' }),
    precio_unit: num(b.precio_unit, { min: 0, name: 'precio unitario' }) ?? 0,
  });
  R('GET', '/api/obras/:id/partidas', ({ user, params }) => partidasConAvance(db, obraFor(user, params.id).id));
  R('POST', '/api/obras/:id/partidas', ({ user, params, body }) => {
    const o = obraFor(user, params.id, { write: true, staff: true });
    const list = Array.isArray(body) ? body : [body];
    if (list.length > 2000) throw bad('Máximo 2000 partidas por carga');
    const rows = list.map(partidaFields);
    db.exec('BEGIN');
    try {
      const ins = db.prepare('INSERT INTO partidas (obra_id,codigo,descripcion,unidad,cantidad,precio_unit) VALUES (?,?,?,?,?,?)');
      for (const p of rows) ins.run(o.id, p.codigo, p.descripcion, p.unidad, p.cantidad, p.precio_unit);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { creadas: rows.length };
  });
  R('PUT', '/api/partidas/:id', ({ user, params, body }) => {
    const p = db.prepare('SELECT * FROM partidas WHERE id = ?').get(Number(params.id));
    if (!p) throw new HttpError(404, 'Partida no encontrada');
    obraFor(user, p.obra_id, { write: true, staff: true });
    const f = partidaFields({ ...p, ...body });
    db.prepare('UPDATE partidas SET codigo=?,descripcion=?,unidad=?,cantidad=?,precio_unit=? WHERE id=?')
      .run(f.codigo, f.descripcion, f.unidad, f.cantidad, f.precio_unit, p.id);
    return { ok: true };
  });
  R('DELETE', '/api/partidas/:id', ({ user, params }) => {
    const p = db.prepare('SELECT * FROM partidas WHERE id = ?').get(Number(params.id));
    if (!p) throw new HttpError(404, 'Partida no encontrada');
    obraFor(user, p.obra_id, { write: true, staff: true });
    db.prepare('DELETE FROM partidas WHERE id = ?').run(p.id);
    return { ok: true };
  });

  // --- avances ---
  R('GET', '/api/obras/:id/avances', ({ user, params }) => {
    const o = obraFor(user, params.id);
    return db.prepare(`SELECT a.*, p.codigo, p.descripcion AS partida, p.unidad, u.nombre AS autor
      FROM avances a JOIN partidas p ON p.id = a.partida_id LEFT JOIN users u ON u.id = a.user_id
      WHERE a.obra_id = ? ORDER BY a.fecha DESC, a.id DESC LIMIT 300`).all(o.id);
  });
  R('POST', '/api/obras/:id/avances', ({ user, params, body }) => {
    const o = obraFor(user, params.id, { write: true });
    const uid = uuid(body.client_uuid);
    const { row, dup } = withIdempotency('avances', uid, () => {
      const p = db.prepare('SELECT * FROM partidas WHERE id = ? AND obra_id = ?').get(Number(body.partida_id), o.id);
      if (!p) throw bad('Partida inválida');
      const cant = num(body.cantidad, { req: true, min: 0.0000001, name: 'cantidad' });
      const id = db.prepare('INSERT INTO avances (partida_id,obra_id,fecha,cantidad,comentario,user_id,client_uuid) VALUES (?,?,?,?,?,?,?)')
        .run(p.id, o.id, date(body.fecha, { req: true }), cant, str(body.comentario, { max: 1000 }), user.id, uid).lastInsertRowid;
      return db.prepare('SELECT * FROM avances WHERE id = ?').get(id);
    });
    return { ...row, duplicado: dup };
  });
  R('DELETE', '/api/avances/:id', ({ user, params }) => {
    const a = db.prepare('SELECT * FROM avances WHERE id = ?').get(Number(params.id));
    if (!a) throw new HttpError(404, 'No encontrado');
    obraFor(user, a.obra_id, { write: true, staff: true });
    db.prepare('DELETE FROM avances WHERE id = ?').run(a.id);
    return { ok: true };
  });

  // --- pagos ---
  R('GET', '/api/obras/:id/pagos', ({ user, params }) =>
    db.prepare('SELECT * FROM pagos WHERE obra_id = ? ORDER BY fecha DESC, id DESC').all(obraFor(user, params.id).id));
  R('POST', '/api/obras/:id/pagos', ({ user, params, body }) => {
    const o = obraFor(user, params.id, { write: true, staff: true });
    const uid = uuid(body.client_uuid);
    const { row, dup } = withIdempotency('pagos', uid, () => {
      const id = db.prepare('INSERT INTO pagos (obra_id,fecha,concepto,monto,user_id,client_uuid) VALUES (?,?,?,?,?,?)')
        .run(o.id, date(body.fecha, { req: true }), str(body.concepto, { req: true, max: 300, name: 'concepto' }),
          num(body.monto, { req: true, name: 'monto' }), user.id, uid).lastInsertRowid;
      return db.prepare('SELECT * FROM pagos WHERE id = ?').get(id);
    });
    return { ...row, duplicado: dup };
  });
  R('DELETE', '/api/pagos/:id', ({ user, params }) => {
    const p = db.prepare('SELECT * FROM pagos WHERE id = ?').get(Number(params.id));
    if (!p) throw new HttpError(404, 'No encontrado');
    obraFor(user, p.obra_id, { write: true, staff: true });
    db.prepare('DELETE FROM pagos WHERE id = ?').run(p.id);
    return { ok: true };
  });

  // --- bitácora ---
  R('GET', '/api/obras/:id/bitacora', ({ user, params }) =>
    db.prepare(`SELECT b.*, u.nombre AS autor FROM bitacora b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.obra_id = ? ORDER BY b.fecha DESC, b.id DESC LIMIT 300`).all(obraFor(user, params.id).id));
  R('POST', '/api/obras/:id/bitacora', ({ user, params, body }) => {
    const o = obraFor(user, params.id, { write: true });
    const uid = uuid(body.client_uuid);
    const { row, dup } = withIdempotency('bitacora', uid, () => {
      const tipo = oneOf(body.tipo, ['nota', 'visita', 'incidencia'], 'nota', 'tipo');
      const id = db.prepare('INSERT INTO bitacora (obra_id,fecha,tipo,severidad,titulo,descripcion,responsable,user_id,client_uuid) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(o.id, date(body.fecha, { req: true }), tipo,
          tipo === 'incidencia' ? oneOf(body.severidad, ['baja', 'media', 'alta'], 'media', 'severidad') : null,
          str(body.titulo, { req: true, max: 200, name: 'título' }), str(body.descripcion, { max: 4000 }),
          str(body.responsable, { max: 200 }), user.id, uid).lastInsertRowid;
      return db.prepare('SELECT * FROM bitacora WHERE id = ?').get(id);
    });
    return { ...row, duplicado: dup };
  });
  R('PUT', '/api/bitacora/:id', ({ user, params, body }) => {
    const b = db.prepare('SELECT * FROM bitacora WHERE id = ?').get(Number(params.id));
    if (!b) throw new HttpError(404, 'No encontrado');
    obraFor(user, b.obra_id, { write: true });
    db.prepare('UPDATE bitacora SET estado = ? WHERE id = ?').run(oneOf(body.estado, ['abierta', 'cerrada'], b.estado, 'estado'), b.id);
    return { ok: true };
  });
  R('DELETE', '/api/bitacora/:id', ({ user, params }) => {
    const b = db.prepare('SELECT * FROM bitacora WHERE id = ?').get(Number(params.id));
    if (!b) throw new HttpError(404, 'No encontrado');
    obraFor(user, b.obra_id, { write: true, staff: true });
    db.prepare('DELETE FROM bitacora WHERE id = ?').run(b.id);
    return { ok: true };
  });

  // --- fotos ---
  const IMG_MAGIC = [
    [Buffer.from([0xff, 0xd8, 0xff]), 'jpg'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'],
    [Buffer.from('RIFF'), 'webp'],
  ];
  R('GET', '/api/obras/:id/fotos', ({ user, params }) =>
    db.prepare(`SELECT f.*, u.nombre AS autor FROM fotos f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.obra_id = ? ORDER BY f.tomada_en DESC, f.id DESC LIMIT 300`).all(obraFor(user, params.id).id));
  R('POST', '/api/obras/:id/fotos', ({ user, params, body }) => {
    const o = obraFor(user, params.id, { write: true });
    const uid = uuid(body.client_uuid);
    const { row, dup } = withIdempotency('fotos', uid, () => {
      const m = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/s.exec(String(body.data || ''));
      if (!m) throw bad('Imagen inválida');
      const buf = Buffer.from(m[1], 'base64');
      const hit = IMG_MAGIC.find(([sig]) => buf.subarray(0, sig.length).equals(sig));
      if (!hit || buf.length < 100) throw bad('Formato de imagen no soportado');
      const archivo = `${crypto.randomUUID()}.${hit[1]}`;
      let bitId = body.bitacora_id ? Number(body.bitacora_id) : null;
      // fotos encoladas sin conexión referencian la bitácora por su client_uuid
      if (!bitId && uuid(body.bitacora_uuid)) {
        bitId = db.prepare('SELECT id FROM bitacora WHERE client_uuid = ? AND obra_id = ?').get(uuid(body.bitacora_uuid), o.id)?.id ?? null;
      }
      if (bitId && !db.prepare('SELECT 1 FROM bitacora WHERE id = ? AND obra_id = ?').get(bitId, o.id)) throw bad('Registro de bitácora inválido');
      const parId = body.partida_id ? Number(body.partida_id) : null;
      if (parId && !db.prepare('SELECT 1 FROM partidas WHERE id = ? AND obra_id = ?').get(parId, o.id)) throw bad('Partida inválida');
      const tomada = String(body.tomada_en || new Date().toISOString());
      if (Number.isNaN(Date.parse(tomada))) throw bad('Fecha de la foto inválida');
      fs.writeFileSync(path.join(UPLOAD_DIR, archivo), buf);
      const id = db.prepare('INSERT INTO fotos (obra_id,bitacora_id,partida_id,archivo,descripcion,lat,lng,tomada_en,user_id,client_uuid) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(o.id, bitId, parId, archivo, str(body.descripcion, { max: 500 }),
          num(body.lat, { min: -90, max: 90 }), num(body.lng, { min: -180, max: 180 }), tomada, user.id, uid).lastInsertRowid;
      return db.prepare('SELECT * FROM fotos WHERE id = ?').get(id);
    });
    return { ...row, duplicado: dup };
  });
  R('DELETE', '/api/fotos/:id', ({ user, params }) => {
    const f = db.prepare('SELECT * FROM fotos WHERE id = ?').get(Number(params.id));
    if (!f) throw new HttpError(404, 'No encontrado');
    obraFor(user, f.obra_id, { write: true, staff: true });
    db.prepare('DELETE FROM fotos WHERE id = ?').run(f.id);
    fs.rm(path.join(UPLOAD_DIR, f.archivo), () => {});
    return { ok: true };
  });

  // --- informes ---
  R('GET', '/api/obras/:id/informe', ({ user, params, query, res }) => {
    const o = obraFor(user, params.id);
    return raw(res, 200, 'text/html; charset=utf-8', report.html(db, o, query));
  });
  R('GET', '/api/obras/:id/informe.xlsx', ({ user, params, query, res }) => {
    const o = obraFor(user, params.id);
    const name = `informe-${o.nombre.replace(/[^\w-]+/g, '_').slice(0, 40)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return raw(res, 200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', report.xlsx(db, o, query));
  });

  // ---------- infraestructura HTTP ----------
  const SECURE = { value: false };
  function cookie(value, maxAge) {
    return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE.value ? '; Secure' : ''}`;
  }
  function setSession(res, uid) { res.setHeader('Set-Cookie', cookie(auth.issueToken(uid), auth.SESSION_DAYS * 86400)); }
  const RAW = Symbol('raw');
  function raw(res, status, type, body) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); return RAW; }

  function currentUser(req) {
    const c = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    const p = auth.verify(c && c[1]);
    if (!p) return null;
    const u = q.userById.get(p.uid);
    return u && u.activo ? u : null;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'Archivo demasiado grande')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('JSON inválido')); }
      });
      req.on('error', reject);
    });
  }

  const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  };

  function serveFile(res, file, cache) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('No encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(data);
    });
  }

  async function handler(req, res) {
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, 'http://x');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw bad('URL inválida'); }
      if (pathname.startsWith('/api/')) {
        const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
        if (!route) {
          if (routes.some((r) => r.re.test(pathname))) throw new HttpError(405, 'Método no permitido');
          throw new HttpError(404, 'Ruta no encontrada');
        }
        const user = currentUser(req);
        if (!route.isOpen && !user) throw new HttpError(401, 'Sesión requerida');
        let body = {};
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          // protección CSRF: las escrituras deben ser JSON
          if (!/application\/json/.test(req.headers['content-type'] || '') && Number(req.headers['content-length'] || 0) > 0) throw new HttpError(415, 'Se requiere JSON');
          body = await readBody(req);
        }
        const params = route.re.exec(pathname).groups || {};
        const out = route.handler({ req, res, user, params, body, query: url.searchParams });
        if (out === RAW) return;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(out));
      }
      if (pathname.startsWith('/uploads/')) {
        const user = currentUser(req);
        if (!user) throw new HttpError(401, 'Sesión requerida');
        const name = path.basename(pathname);
        const f = db.prepare('SELECT obra_id FROM fotos WHERE archivo = ?').get(name);
        if (!f) throw new HttpError(404, 'No encontrado');
        obraFor(user, f.obra_id);
        return serveFile(res, path.join(UPLOAD_DIR, name), 'private, max-age=31536000, immutable');
      }
      // archivos estáticos
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Prohibido');
      const isShell = /\.(html|js|css|webmanifest)$/.test(file);
      return serveFile(res, file, isShell ? 'no-cache' : 'public, max-age=86400');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Error interno del servidor' : e.message }));
    }
  }

  return { handler, SECURE };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function start() {
  const db = open();
  const app = createApp(db);
  const port = Number(process.env.PORT || 3000);
  const certDir = path.join(__dirname, '..', 'certs');
  const keyF = process.env.TLS_KEY || path.join(certDir, 'key.pem');
  const certF = process.env.TLS_CERT || path.join(certDir, 'cert.pem');
  const useTls = fs.existsSync(keyF) && fs.existsSync(certF);
  app.SECURE.value = useTls || process.env.BEHIND_HTTPS === '1';
  const server = useTls
    ? https.createServer({ key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) }, app.handler)
    : http.createServer(app.handler);
  const proto = useTls ? 'https' : 'http';
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log('\nMonitoreo de obras en marcha');
    console.log(`  En esta PC:      ${proto}://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  Desde el celular: ${proto}://${ip}:${port}   (misma red WiFi)`);
    if (!useTls) console.log('  Aviso: sin HTTPS el celular no permitirá GPS ni instalar la app. Ver README (certificado o túnel).');
  });
  return server;
}

if (require.main === module) start();
module.exports = { createApp };
