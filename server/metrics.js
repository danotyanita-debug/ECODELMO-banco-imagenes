'use strict';

const round = (n, d = 1) => Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function plannedPct(obra, today = new Date()) {
  if (!obra.fecha_inicio || !obra.fecha_fin) return null;
  const a = Date.parse(obra.fecha_inicio), b = Date.parse(obra.fecha_fin);
  if (!(b > a)) return null;
  return round(clamp(((today.getTime() - a) / (b - a)) * 100, 0, 100));
}

function resumenObra(db, obra) {
  const t = db.prepare(`
    SELECT COALESCE(SUM(p.cantidad * p.precio_unit), 0) AS total,
           COALESCE(SUM(MIN(COALESCE(e.q, 0), p.cantidad) * p.precio_unit), 0) AS ejecutado
    FROM partidas p
    LEFT JOIN (SELECT partida_id, SUM(cantidad) q FROM avances GROUP BY partida_id) e ON e.partida_id = p.id
    WHERE p.obra_id = ?`).get(obra.id);
  const pagado = db.prepare('SELECT COALESCE(SUM(monto),0) AS s FROM pagos WHERE obra_id = ?').get(obra.id).s;
  const abiertas = db.prepare(`SELECT COUNT(*) AS n FROM bitacora WHERE obra_id = ? AND tipo = 'incidencia' AND estado = 'abierta'`).get(obra.id).n;
  const fotos = db.prepare('SELECT COUNT(*) AS n FROM fotos WHERE obra_id = ?').get(obra.id).n;
  const ultimo = db.prepare('SELECT MAX(fecha) AS f FROM avances WHERE obra_id = ?').get(obra.id).f;

  const fisico = t.total > 0 ? round((t.ejecutado / t.total) * 100) : 0;
  const financiero = obra.presupuesto > 0 ? round((pagado / obra.presupuesto) * 100) : 0;
  const plan = plannedPct(obra);
  const desviacion = plan === null ? null : round(fisico - plan);
  let semaforo = 'gris';
  if (obra.estado === 'terminada') semaforo = 'verde';
  else if (desviacion !== null) semaforo = desviacion >= -5 ? 'verde' : desviacion >= -15 ? 'amarillo' : 'rojo';
  return {
    valor_total_partidas: round(t.total, 2), valor_ejecutado: round(t.ejecutado, 2),
    pagado: round(pagado, 2), avance_fisico: fisico, avance_financiero: financiero,
    avance_planificado: plan, desviacion, semaforo,
    incidencias_abiertas: abiertas, total_fotos: fotos, ultimo_avance: ultimo,
  };
}

function partidasConAvance(db, obraId) {
  return db.prepare(`
    SELECT p.*, COALESCE((SELECT SUM(cantidad) FROM avances a WHERE a.partida_id = p.id), 0) AS ejecutado
    FROM partidas p WHERE p.obra_id = ? ORDER BY p.codigo, p.id`).all(obraId)
    .map((p) => ({ ...p, avance_pct: p.cantidad > 0 ? round(clamp((p.ejecutado / p.cantidad) * 100, 0, 100)) : 0 }));
}

module.exports = { resumenObra, partidasConAvance, round };
