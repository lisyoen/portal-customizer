// Command line: create or reset an admin account.
//   PC_PASSWORD='...' node server/cli.js admin <user> [name]
"use strict";
const path = require("path");
const { Store } = require("./lib/store");
const A = require("./lib/auth");
const [cmd, user, name] = process.argv.slice(2);
const DATA = path.resolve(process.env.PC_DATA || path.join(__dirname, "data"));
if (cmd !== "admin" || !user) { console.error("usage: PC_PASSWORD=... node cli.js admin <user> [name]"); process.exit(2); }
const pw = process.env.PC_PASSWORD || "";
if (pw.length < 8) { console.error("PC_PASSWORD must be at least 8 characters"); process.exit(2); }
const store = new Store(DATA);
let a = store.data.admins.find((x) => x.user === user);
if (a) { Object.assign(a, A.hashPassword(pw)); a.disabled = false; a.role = "admin"; store.data.tokens = store.data.tokens.filter((t) => t.adminId !== a.id); console.log("password reset: " + user); }
else { a = Object.assign({ id: A.id("a"), user, name: name || user, role: "admin", createdAt: new Date().toISOString() }, A.hashPassword(pw)); store.data.admins.push(a); console.log("admin created: " + user); }
store.audit("cli", "관리자 설정(CLI)", user); store.save();
