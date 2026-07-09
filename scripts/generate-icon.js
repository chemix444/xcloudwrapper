'use strict';

// Generates build/icon.png (1024x1024 RGBA): a dark rounded-square tile with
// an Xbox-green sphere and a white cloud glyph. Zero dependencies — writes
// the PNG by hand with node:zlib. electron-builder converts this PNG into
// the .icns at package time.
//
// Regenerate with: npm run icon

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;

// --- Signed distance functions (in pixels; negative = inside) -------------

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

// 1px antialiased coverage from a signed distance.
function coverage(d) {
  return Math.min(1, Math.max(0, 0.5 - d));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// --- Compose one pixel ------------------------------------------------------

function pixel(x, y) {
  const p = { r: 0, g: 0, b: 0, a: 0 };

  // Tile: rounded square, macOS-style corner radius (~22.5% of size).
  const tile = coverage(sdRoundedRect(x, y, 512, 512, 464, 464, 208));
  if (tile <= 0) return p;

  // Background: subtle vertical gradient, near-black blue-grey.
  const t = y / SIZE;
  let r = mix(26, 10, t);
  let g = mix(32, 14, t);
  let b = mix(38, 18, t);

  // Sphere: Xbox green with an upper-left radial highlight.
  const dSphere = sdCircle(x, y, 512, 512, 330);
  const sphere = coverage(dSphere);
  if (sphere > 0) {
    const hl = Math.max(0, 1 - Math.hypot(x - 400, y - 400) / 660);
    const sr = mix(14, 68, hl * hl) + 2;
    const sg = mix(96, 190, hl * hl);
    const sb = mix(14, 62, hl * hl) + 2;
    r = mix(r, sr, sphere);
    g = mix(g, sg, sphere);
    b = mix(b, sb, sphere);
  }

  // Cloud: union of three circles and a rounded bar for the flat base.
  const dCloud = Math.min(
    sdCircle(x, y, 400, 545, 92),
    sdCircle(x, y, 512, 480, 118),
    sdCircle(x, y, 628, 550, 84),
    sdRoundedRect(x, y, 514, 600, 200, 36, 36)
  );
  const cloud = coverage(dCloud);
  if (cloud > 0) {
    r = mix(r, 245, cloud);
    g = mix(g, 247, cloud);
    b = mix(b, 250, cloud);
  }

  p.r = Math.round(r);
  p.g = Math.round(g);
  p.b = Math.round(b);
  p.a = Math.round(tile * 255);
  return p;
}

// --- Minimal PNG encoder -----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression / filter / interlace = 0

  // Raw scanlines: 1 filter byte (0 = None) + RGBA per pixel.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let off = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[off++] = 0;
    for (let x = 0; x < SIZE; x++) {
      const { r, g, b, a } = pixel(x, y);
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
      raw[off++] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, encodePng());
console.log(`wrote ${outPath}`);
