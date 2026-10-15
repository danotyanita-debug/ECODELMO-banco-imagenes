'use strict';
// Genera los iconos PNG de la PWA sin dependencias: node scripts/gen-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = draw(x / size, y / size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const NAVY = [15, 23, 42], AMBER = [245, 158, 11], DARK = [180, 83, 9], WHITE = [248, 250, 252];
function casco(u, v) {
  const cx = 0.5, cy = 0.56;
  const dx = u - cx, dy = v - cy;
  if (dy <= 0 && dx * dx + dy * dy <= 0.27 * 0.27) {
    if (Math.abs(dx) < 0.035 && dy > -0.27) return DARK;   // cresta del casco
    return AMBER;
  }
  if (v >= 0.56 && v <= 0.64 && u >= 0.17 && u <= 0.83) return AMBER; // ala
  if (v > 0.64 && v <= 0.69 && u >= 0.2 && u <= 0.8) return DARK;
  // barra de progreso
  if (v >= 0.76 && v <= 0.82 && u >= 0.22 && u <= 0.78) return u <= 0.62 ? WHITE : [71, 85, 105];
  return NAVY;
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(out, name), png(size, casco));
  console.log('generado', name);
}
