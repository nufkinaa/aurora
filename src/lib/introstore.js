// The skip-intro ranges store, shared between the player-facing routes
// (api.js GET/POST/DELETE by key) and the admin manager (list/delete). One
// JsonStore instance — two stores on the same file would clobber each other's
// debounced writes.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

module.exports = new JsonStore(path.join(config.DATA_DIR, "intros.json"), {});
