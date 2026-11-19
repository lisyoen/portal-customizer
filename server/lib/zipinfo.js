// Read one file out of a zip archive (stored or deflated) without dependencies: used to check the
// extension package an administrator uploads (manifest.json version) before publishing it.
"use strict";
const zlib = require("zlib");

function readEntry(buf, name) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("zip 파일이 아닙니다");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 파일이 아닙니다");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (entry !== name) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip 구조가 올바르지 않습니다");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error("지원하지 않는 압축 방식입니다");
  }
  return null;
}

module.exports = { readEntry };
