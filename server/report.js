'use strict';
const { resumenObra, partidasConAvance } = require('./metrics');
const { buildXlsx } = require('./xlsx');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function range(q) {
  const ok = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
  return { desde: ok(q.get('desde')) || '0000-01-01', hasta: ok(q.get('hasta')) || '9999-12-31' };
}

function collect(db, obra, q) {
  const { desde, hasta } = range(q);
  return {
    desde, hasta,
    resumen: resumenObra(db, obra),
    partidas: partidasConAvance(db, obra.id),
    avances: db.prepare(`SELECT a.*, p.codigo, p.descripcion AS partida, p.unidad, u.nombre AS autor
      FROM avances a JOIN partidas p ON p.id = a.partida_id LEFT JOIN users u ON u.id = a.user_id
      WHERE a.obra_id = ? AND a.fecha BETWEEN ? AND ? ORDER BY a.fecha, a.id`).all(obra.id, desde, hasta),
    pagos: db.prepare('SELECT * FROM pagos WHERE obra_id = ? AND fecha BETWEEN ? AND ? ORDER BY fecha, id').all(obra.id, desde, hasta),
    bitacora: db.prepare(`SELECT b.*, u.nombre AS autor FROM bitacora b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.obra_id = ? AND b.fecha BETWEEN ? AND ? ORDER BY b.fecha, b.id`).all(obra.id, desde, hasta),
    fotos: db.prepare(`SELECT f.*, u.nombre AS autor FROM fotos f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.obra_id = ? AND substr(f.tomada_en,1,10) BETWEEN ? AND ? ORDER BY f.tomada_en LIMIT 200`).all(obra.id, desde, hasta),
  };
}

function html(db, obra, q) {
  const d = collect(db, obra, q);
  const r = d.resumen;
  const periodo = d.desde === '0000-01-01' && d.hasta === '9999-12-31' ? 'Todo el periodo' : `${d.desde === '0000-01-01' ? '…' : d.desde} a ${d.hasta === '9999-12-31' ? '…' : d.hasta}`;
  const bar = (p) => `<div class="bar"><span style="width:${Math.min(100, p)}%"></span></div>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe – ${esc(obra.nombre)}</title>
<style>
body{font:14px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#1b1f23;max-width:900px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px;border-bottom:2px solid #f59e0b;padding-bottom:4px}
.meta{color:#555;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.card{border:1px solid #ddd;border-radius:8px;padding:8px 10px}.card b{display:block;font-size:20px}
.bar{height:8px;background:#eee;border-radius:4px;overflow:hidden;margin-top:4px}.bar span{display:block;height:100%;background:#f59e0b}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f5f5f5}
td.n{text-align:right;white-space:nowrap}.fotos{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
figure{margin:0;break-inside:avoid}figure img{width:100%;border-radius:6px;display:block}figcaption{font-size:11.5px;color:#444}
.btn{background:#f59e0b;border:0;padding:8px 14px;border-radius:6px;font-weight:600;cursor:pointer}
.sem-verde{color:#15803d}.sem-amarillo{color:#b45309}.sem-rojo{color:#b91c1c}
@media print{.noprint{display:none}body{padding:0}}
</style></head><body>
<p class="noprint"><button class="btn" id="imprimir">Imprimir / Guardar como PDF</button></p>
<h1>Informe de seguimiento – ${esc(obra.nombre)}</h1>
<div class="meta">${esc(obra.codigo || '')} · ${esc(obra.ubicacion || '')} · Cliente: ${esc(obra.cliente || '-')} · Contratista: ${esc(obra.contratista || '-')}<br>
Periodo: ${esc(periodo)} · Emitido: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
<h2>Resumen</h2>
<div class="grid">
<div class="card">Avance físico<b>${r.avance_fisico}%</b>${bar(r.avance_fisico)}</div>
<div class="card">Avance financiero (pagado)<b>${r.avance_financiero}%</b>${bar(r.avance_financiero)}</div>
<div class="card">Avance planificado (por tiempo)<b>${r.avance_planificado ?? '-'}${r.avance_planificado === null ? '' : '%'}</b>${bar(r.avance_planificado || 0)}</div>
<div class="card">Desviación<b class="sem-${r.semaforo}">${r.desviacion === null ? '-' : (r.desviacion > 0 ? '+' : '') + r.desviacion + ' pp'}</b></div>
<div class="card">Presupuesto<b>${money(obra.presupuesto)}</b></div>
<div class="card">Valor ejecutado<b>${money(r.valor_ejecutado)}</b></div>
<div class="card">Pagado<b>${money(r.pagado)}</b></div>
<div class="card">Incidencias abiertas<b>${r.incidencias_abiertas}</b></div>
</div>
<h2>Partidas</h2>
<table><tr><th>Cód.</th><th>Descripción</th><th>Und</th><th>Metrado</th><th>Ejecutado</th><th>%</th><th>P.U.</th></tr>
${d.partidas.map((p) => `<tr><td>${esc(p.codigo)}</td><td>${esc(p.descripcion)}</td><td>${esc(p.unidad)}</td><td class="n">${p.cantidad}</td><td class="n">${p.ejecutado}</td><td class="n">${p.avance_pct}%</td><td class="n">${money(p.precio_unit)}</td></tr>`).join('') || '<tr><td colspan="7">Sin partidas</td></tr>'}
</table>
<h2>Avances registrados</h2>
<table><tr><th>Fecha</th><th>Partida</th><th>Cantidad</th><th>Comentario</th><th>Registró</th></tr>
${d.avances.map((a) => `<tr><td>${esc(a.fecha)}</td><td>${esc(a.codigo || '')} ${esc(a.partida)}</td><td class="n">${a.cantidad} ${esc(a.unidad)}</td><td>${esc(a.comentario)}</td><td>${esc(a.autor)}</td></tr>`).join('') || '<tr><td colspan="5">Sin avances en el periodo</td></tr>'}
</table>
<h2>Pagos / valorizaciones</h2>
<table><tr><th>Fecha</th><th>Concepto</th><th>Monto</th></tr>
${d.pagos.map((p) => `<tr><td>${esc(p.fecha)}</td><td>${esc(p.concepto)}</td><td class="n">${money(p.monto)}</td></tr>`).join('') || '<tr><td colspan="3">Sin pagos en el periodo</td></tr>'}
</table>
<h2>Bitácora e incidencias</h2>
<table><tr><th>Fecha</th><th>Tipo</th><th>Título / detalle</th><th>Severidad</th><th>Estado</th><th>Responsable</th></tr>
${d.bitacora.map((b) => `<tr><td>${esc(b.fecha)}</td><td>${esc(b.tipo)}</td><td><b>${esc(b.titulo)}</b><br>${esc(b.descripcion)}</td><td>${esc(b.severidad || '')}</td><td>${esc(b.estado)}</td><td>${esc(b.responsable || b.autor)}</td></tr>`).join('') || '<tr><td colspan="6">Sin registros en el periodo</td></tr>'}
</table>
<h2>Registro fotográfico</h2>
<div class="fotos">
${d.fotos.map((f) => `<figure><img loading="lazy" src="/uploads/${esc(f.archivo)}" alt=""><figcaption>${esc(f.tomada_en.replace('T', ' ').slice(0, 16))}${f.lat != null ? ` · ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}` : ''}<br>${esc(f.descripcion)}</figcaption></figure>`).join('') || '<p>Sin fotos en el periodo</p>'}
</div>
<script src="/report.js"></script>
</body></html>`;
}

function xlsx(db, obra, q) {
  const d = collect(db, obra, q);
  const r = d.resumen;
  return buildXlsx([
    { name: 'Resumen', rows: [['Indicador', 'Valor'],
      ['Obra', obra.nombre], ['Código', obra.codigo || ''], ['Ubicación', obra.ubicacion || ''],
      ['Cliente', obra.cliente || ''], ['Contratista', obra.contratista || ''],
      ['Presupuesto', obra.presupuesto], ['Valor ejecutado', r.valor_ejecutado], ['Pagado', r.pagado],
      ['Avance físico %', r.avance_fisico], ['Avance financiero %', r.avance_financiero],
      ['Avance planificado %', r.avance_planificado], ['Desviación (pp)', r.desviacion],
      ['Incidencias abiertas', r.incidencias_abiertas]] },
    { name: 'Partidas', rows: [['Código', 'Descripción', 'Unidad', 'Metrado', 'Ejecutado', 'Avance %', 'Precio unit.', 'Valor ejecutado'],
      ...d.partidas.map((p) => [p.codigo, p.descripcion, p.unidad, p.cantidad, p.ejecutado, p.avance_pct, p.precio_unit, Math.min(p.ejecutado, p.cantidad) * p.precio_unit])] },
    { name: 'Avances', rows: [['Fecha', 'Código', 'Partida', 'Cantidad', 'Unidad', 'Comentario', 'Registró'],
      ...d.avances.map((a) => [a.fecha, a.codigo, a.partida, a.cantidad, a.unidad, a.comentario, a.autor])] },
    { name: 'Pagos', rows: [['Fecha', 'Concepto', 'Monto'], ...d.pagos.map((p) => [p.fecha, p.concepto, p.monto])] },
    { name: 'Bitácora', rows: [['Fecha', 'Tipo', 'Título', 'Descripción', 'Severidad', 'Estado', 'Responsable', 'Registró'],
      ...d.bitacora.map((b) => [b.fecha, b.tipo, b.titulo, b.descripcion, b.severidad, b.estado, b.responsable, b.autor])] },
    { name: 'Fotos', rows: [['Fecha/hora', 'Archivo', 'Descripción', 'Latitud', 'Longitud', 'Registró'],
      ...d.fotos.map((f) => [f.tomada_en, f.archivo, f.descripcion, f.lat, f.lng, f.autor])] },
  ]);
}

module.exports = { html, xlsx };
