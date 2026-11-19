"use strict";
const crypto = require("crypto");

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash: h };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64);
  const b = Buffer.from(hash, "hex");
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}
function newToken() { return crypto.randomBytes(32).toString("base64url"); }
function tokenHash(t) { return crypto.createHash("sha256").update(String(t)).digest("hex"); }
function id(prefix) { return (prefix || "") + crypto.randomBytes(6).toString("hex"); }
module.exports = { hashPassword, verifyPassword, newToken, tokenHash, id };
