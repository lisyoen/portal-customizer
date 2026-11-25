"use strict";
module.exports = (api) => { api.route("GET", "/who", () => ({ providers: api.use("identity").map((x) => `${x.plugin}:${x.name}:${x.describe()}`) })); };
