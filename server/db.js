'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function open(file) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const db = new DatabaseSync(file || path.join(DATA_DIR, 'obras.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','supervisor','residente','lector')),
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS obras (
  id INTEGER PRIMARY KEY,
  codigo TEXT,
  nombre TEXT NOT NULL,
  ubicacion TEXT,
  cliente TEXT,
  contratista TEXT,
  fecha_inicio TEXT,
  fecha_fin TEXT,
  presupuesto REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'en_ejecucion'
    CHECK (estado IN ('planificada','en_ejecucion','paralizada','terminada')),
  lat REAL, lng REAL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS obra_miembros (
  obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (obra_id, user_id)
);
CREATE TABLE IF NOT EXISTS partidas (
  id INTEGER PRIMARY KEY,
  obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
  codigo TEXT,
  descripcion TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT 'glb',
  cantidad REAL NOT NULL DEFAULT 1,
  precio_unit REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS avances (
  id INTEGER PRIMARY KEY,
  partida_id INTEGER NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
  obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  cantidad REAL NOT NULL,
  comentario TEXT,
  user_id INTEGER REFERENCES users(id),
  client_uuid TEXT UNIQUE,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY,
  obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  monto REAL NOT NULL,
  user_id INTEGER REFERENCES users(id),
  client_uuid TEXT UNIQUE,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY,
  obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'nota' CHECK (tipo IN ('nota','visita','incidencia')),
  severidad TEXT CHECK (severidad IN ('baja','media','alta')),
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  titulo TEXT NOT NULL,
  descripcion TEXT,
  responsable TEXT,
  user_id INTEGER REFERENCES users(id),
  client_uuid TEXT UNIQUE,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fotos (
  id INTEGER PRIMARY KEY,
  obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
  bitacora_id INTEGER REFERENCES bitacora(id) ON DELETE SET NULL,
  partida_id INTEGER REFERENCES partidas(id) ON DELETE SET NULL,
  archivo TEXT NOT NULL,
  descripcion TEXT,
  lat REAL, lng REAL,
  tomada_en TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  client_uuid TEXT UNIQUE,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avances_obra ON avances(obra_id, fecha);
CREATE INDEX IF NOT EXISTS idx_bitacora_obra ON bitacora(obra_id, fecha);
CREATE INDEX IF NOT EXISTS idx_fotos_obra ON fotos(obra_id, tomada_en);
CREATE INDEX IF NOT EXISTS idx_pagos_obra ON pagos(obra_id, fecha);
`);
  return db;
}

module.exports = { open, UPLOAD_DIR, DATA_DIR };
