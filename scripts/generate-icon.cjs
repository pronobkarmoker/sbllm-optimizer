// One-off generator for media/icon.png — a 128x128 rounded-square icon with a lightning bolt,
// matching the $(zap) command icon and "⚡" used elsewhere in the extension's UI. Hand-rolled
// PNG encoding (raw scanlines -> zlib deflate -> chunks) since there's no image tool or image
// library dependency in this project, and the Marketplace requires a PNG (SVG icons are rejected).
// Not part of the extension build — run manually if the icon ever needs regenerating.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 128;
const BG = [15, 20, 30]; // dark slate navy
const BOLT = [245, 197, 24]; // amber, matching the paper's "speedup" energy motif
const BOLT_OUTLINE = [124, 92, 0];

function roundedRectContains(x, y, w, h, r) {
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 0.5;
}

// Classic zigzag lightning bolt, defined in a 100x100 box, scaled/centered into the canvas below.
const BOLT_POINTS = [
  [58, 6],
  [22, 58],
  [46, 58],
  [38, 122],
  [50, 122],
  [86, 62],
  [60, 62],
  [82, 18],
];

function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToPolygonEdge(px, py, points) {
  let min = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[j];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = x1 + t * dx;
    const ey = y1 + t * dy;
    const d = Math.hypot(px - ex, py - ey);
    if (d < min) min = d;
  }
  return min;
}

const boltScale = 0.72;
const boltOffsetX = SIZE * 0.14;
const boltOffsetY = SIZE * 0.0;
const scaledBolt = BOLT_POINTS.map(([x, y]) => [x * boltScale * 0.01 * SIZE + boltOffsetX, y * boltScale * 0.01 * SIZE + boltOffsetY]);

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let pos = 0;
for (let y = 0; y < SIZE; y++) {
  raw[pos++] = 0; // filter type: None
  for (let x = 0; x < SIZE; x++) {
    const inRounded = roundedRectContains(x + 0.5, y + 0.5, SIZE, SIZE, 26);
    let r, g, b, a;
    if (!inRounded) {
      r = g = b = a = 0;
    } else {
      const inBolt = pointInPolygon(x + 0.5, y + 0.5, scaledBolt);
      const edgeDist = distToPolygonEdge(x + 0.5, y + 0.5, scaledBolt);
      if (inBolt) {
        const outline = edgeDist < 1.6;
        [r, g, b] = outline ? BOLT_OUTLINE : BOLT;
      } else {
        [r, g, b] = BG;
      }
      a = 255;
    }
    raw[pos++] = r;
    raw[pos++] = g;
    raw[pos++] = b;
    raw[pos++] = a;
  }
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const idatData = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idatData),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'media');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
