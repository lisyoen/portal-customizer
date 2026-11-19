import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const D = require("../extension/lib/detect.js");

const box = (left, top, width, height) => ({ left, top, width, height });

test("groupColumns: columns by left edge, items top to bottom", () => {
  const b = [box(0, 0, 300, 100), box(320, 0, 600, 200), box(2, 120, 300, 100), box(320, 220, 600, 50), box(940, 0, 300, 400)];
  assert.deepEqual(D.groupColumns(b), [[0, 2], [1, 3], [4]]);
});

test("groupColumns: a narrower box under a wide one joins that column", () => {
  const b = [box(0, 0, 600, 100), box(40, 120, 300, 100), box(640, 0, 300, 100)];
  assert.deepEqual(D.groupColumns(b), [[0, 1], [2]]);
});

test("groupColumns: a row of cards becomes one column per card", () => {
  const b = [box(0, 0, 200, 100), box(220, 0, 200, 100), box(440, 0, 200, 100)];
  assert.equal(D.groupColumns(b).length, 3);
});

test("scoreOf: needs two widgets in two columns; prefers components and coverage", () => {
  assert.equal(D.scoreOf({ widgets: 1, columns: 1, areaFrac: 1, compFrac: 1, coverage: 1 }), 0);
  assert.equal(D.scoreOf({ widgets: 4, columns: 1, areaFrac: 1, compFrac: 1, coverage: 1 }), 0);
  const comp = D.scoreOf({ widgets: 6, columns: 3, areaFrac: 0.7, compFrac: 1, coverage: 0.8 });
  const dom = D.scoreOf({ widgets: 6, columns: 3, areaFrac: 0.7, compFrac: 0, coverage: 0.8 });
  const page = D.scoreOf({ widgets: 3, columns: 2, areaFrac: 1, compFrac: 0, coverage: 0.9 });
  assert.ok(comp > dom && dom > page, JSON.stringify({ comp, dom, page }));
});
