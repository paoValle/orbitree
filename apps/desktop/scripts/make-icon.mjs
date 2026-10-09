#!/usr/bin/env node
/**
 * Writes the tray icon as a PNG, so the repository carries a source for it rather than a
 * binary nobody can review or change.
 *
 * A tray icon is a small monochrome mark: on macOS the system draws it, on Windows it is
 * drawn as-is, and 16x16 is the size both agree on. A circle and a fork, because that is
 * the product's whole shape.
 *
 * Usage: node apps/desktop/scripts/make-icon.mjs [output]
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 16;
const OUTPUT =
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tray.png');

/** RGBA, top-left origin. */
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const at = (y * SIZE + x) * 4;
  pixels[at] = r;
  pixels[at + 1] = g;
  pixels[at + 2] = b;
  pixels[at + 3] = a;
}

// A disc, slightly inset, in the same blue the graph's first lane uses.
const CENTRE = (SIZE - 1) / 2;
const RADIUS = 6.4;
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const distance = Math.hypot(x - CENTRE, y - CENTRE);
    if (distance <= RADIUS) {
      // Edges anti-aliased by alpha, because a hard 16x16 circle looks stamped on.
      const edge = Math.min(1, (RADIUS - distance) / 0.8);
      set(x, y, [106, 169, 255, Math.round(edge * 255)]);
    }
  }
}

// A fork leaving the disc downwards, the one shape that says "repository".
const SCREEN = 255;
for (let y = 1; y < 4; y += 1) {
  set(7, y, [SCREEN, SCREEN, SCREEN, 230]);
  set(9, y, [SCREEN, SCREEN, SCREEN, 230]);
  set(8, y, [SCREEN, SCREEN, SCREEN, 240]);
}

const IHDR = Buffer.alloc(13);
IHDR.writeUInt32BE(SIZE, 0);
IHDR.writeUInt32BE(SIZE, 4);
IHDR[8] = 8; // bit depth
IHDR[9] = 6; // colour type: truecolour with alpha
IHDR[10] = 0; // deflate
IHDR[11] = 0; // adaptive filtering
IHDR[12] = 0; // no interlace

// Each row is prefixed with its filter type: none, which is what an icon needs.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', IHDR),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, png);
process.stdout.write(`wrote ${OUTPUT} (${png.length} bytes)\n`);

/** The PNG CRC, which is the only thing in the format that is not a length. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
