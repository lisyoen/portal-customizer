// Put one file into a zip archive (replacing an entry of the same name) without dependencies: used to hand out
// the extension package with this server's connection settings in config.json.
"use strict";
const zlib = require("zlib");

let table = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function putEntry(buf, name, content) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("zip 파일이 아닙니다");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 파일이 아닙니다");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const locals = [], centrals = [];
  let offset = 0;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 구조가 올바르지 않습니다");
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const central = Buffer.from(buf.slice(p, p + 46 + nlen + xlen + clen));
    p += 46 + nlen + xlen + clen;
    if (entry === name) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip 구조가 올바르지 않습니다");
    const flags = buf.readUInt16LE(local + 6);
    const end = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28) + csize + (flags & 8 ? (buf.readUInt32LE(local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28) + csize) === 0x08074b50 ? 16 : 12) : 0);
    const chunk = buf.slice(local, end);
    central.writeUInt32LE(offset, 42);
    locals.push(chunk); centrals.push(central);
    offset += chunk.length;
  }
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const packed = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt32LE(0x81a40000, 38); ch.writeUInt32LE(offset, 42);
  locals.push(Buffer.concat([lh, nameBuf, packed]));
  centrals.push(Buffer.concat([ch, nameBuf]));
  offset += lh.length + nameBuf.length + packed.length;
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length, 8); end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { putEntry, crc32 };
