// Generates assets/icon.png (256px), assets/tray.png (16px) and assets/tray@2x.png (32px)
// without any image dependencies: a rounded dark tile with a 2×2 grid of category colors.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const inRoundRect = (x, y, rx, ry, w, h, r) => {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return x >= rx && x <= rx + w && y >= ry && y <= ry + h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function draw(size, { background, fullBleed = false }) {
  const S = 4; // supersampling
  const out = Buffer.alloc(size * size * 4);
  const u = 1 / size; // work in unit coordinates
  const tiles = [
    ['#3B82F6', 0.2, 0.2], ['#10B981', 0.52, 0.2],
    ['#F59E0B', 0.2, 0.52], ['#8B5CF6', 0.52, 0.52],
  ];
  const tile = 0.28, tileR = size <= 16 ? 0.05 : 0.07;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) * u, y = (py + (sy + 0.5) / S) * u;
          let col = null;
          for (const [c, tx, ty] of tiles) if (inRoundRect(x, y, tx, ty, tile, tile, tileR)) col = hex(c);
          if (!col && background && (fullBleed || inRoundRect(x, y, 0.02, 0.02, 0.96, 0.96, 0.22))) {
            const t = y; // subtle vertical gradient
            col = [Math.round(30 - 10 * t), Math.round(36 - 12 * t), Math.round(54 - 16 * t)];
          }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
        }
      }
      const n = S * S, i = (py * size + px) * 4, cov = a / 255;
      out[i] = cov ? r / cov : 0; out[i + 1] = cov ? g / cov : 0; out[i + 2] = cov ? b / cov : 0; out[i + 3] = a / n;
    }
  }
  return png(size, out);
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), draw(256, { background: true }));
fs.writeFileSync(path.join(dir, 'tray.png'), draw(16, { background: true }));
fs.writeFileSync(path.join(dir, 'tray@2x.png'), draw(32, { background: true }));
// iPhone web app: square, full-bleed icons (iOS rounds the corners itself).
const web = path.join(__dirname, '..', 'docs', 'icons');
fs.mkdirSync(web, { recursive: true });
fs.writeFileSync(path.join(web, 'apple-touch-icon.png'), draw(180, { background: true, fullBleed: true }));
fs.writeFileSync(path.join(web, 'icon-192.png'), draw(192, { background: true, fullBleed: true }));
fs.writeFileSync(path.join(web, 'icon-512.png'), draw(512, { background: true, fullBleed: true }));
console.log('Icons written to', dir, 'and', web);
