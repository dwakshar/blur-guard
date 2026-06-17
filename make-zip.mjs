// Builds blurguard-v1.0.0.zip with POSIX-style entry paths (forward slashes).
// Opera and Chrome both require this; Windows Compress-Archive / 7z use backslashes.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SRC = "dist";
const OUT = "blurguard-v1.0.0.zip";

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const byte of buf) crc = (table[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16LE(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function uint32LE(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function walkDir(dir, base = "") {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) entries.push(...walkDir(full, rel));
    else entries.push({ full, rel });
  }
  return entries;
}

const files = walkDir(SRC);
const localHeaders = [];
const centralHeaders = [];
let offset = 0;

for (const { full, rel } of files) {
  const raw = fs.readFileSync(full);
  const compressed = zlib.deflateRawSync(raw, { level: 6 });
  const usable = compressed.length < raw.length ? compressed : raw;
  const method = usable === compressed ? 8 : 0;
  const crc = crc32(raw);
  const { date, time } = dosDateTime(fs.statSync(full).mtime);
  const name = Buffer.from(rel, "utf8");

  // Local file header
  const local = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    uint16LE(20),          // version needed
    uint16LE(0),           // flags
    uint16LE(method),
    uint16LE(time),
    uint16LE(date),
    uint32LE(crc),
    uint32LE(usable.length),
    uint32LE(raw.length),
    uint16LE(name.length),
    uint16LE(0),           // extra length
    name,
    usable,
  ]);
  localHeaders.push(local);

  // Central directory entry
  const central = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    uint16LE(20),          // version made by
    uint16LE(20),          // version needed
    uint16LE(0),           // flags
    uint16LE(method),
    uint16LE(time),
    uint16LE(date),
    uint32LE(crc),
    uint32LE(usable.length),
    uint32LE(raw.length),
    uint16LE(name.length),
    uint16LE(0),           // extra
    uint16LE(0),           // comment
    uint16LE(0),           // disk start
    uint16LE(0),           // internal attr
    uint32LE(0),           // external attr
    uint32LE(offset),
    name,
  ]);
  centralHeaders.push(central);
  offset += local.length;
}

const centralDir = Buffer.concat(centralHeaders);
const centralSize = centralDir.length;
const centralOffset = offset;

const eocd = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  uint16LE(0),
  uint16LE(0),
  uint16LE(files.length),
  uint16LE(files.length),
  uint32LE(centralSize),
  uint32LE(centralOffset),
  uint16LE(0),
]);

fs.writeFileSync(OUT, Buffer.concat([...localHeaders, centralDir, eocd]));
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`✓ ${OUT} — ${mb} MB — ${files.length} files`);
