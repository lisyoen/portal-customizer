// JSON file store with atomic writes. Small data (layouts, contents metadata, admins, stats).
"use strict";
const fs = require("fs");
const path = require("path");

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    this.data = this.load();
    this.timer = null;
  }
  load() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    return Object.assign({ schema: 1, admins: [], tokens: [], layouts: [], groups: [], contents: [], settings: {}, audit: [], stats: {} }, d);
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  // Coalesce frequent writes (stats) into one write per second.
  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, 1000);
  }
  flush() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.save(); }
  audit(by, action, target, detail) {
    this.data.audit.unshift({ at: new Date().toISOString(), by: by || "", action, target: target || "", detail: detail || "" });
    if (this.data.audit.length > 3000) this.data.audit.length = 3000;
  }
}
module.exports = { Store };
