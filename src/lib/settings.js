// App-written runtime settings, kept SEPARATE from config.json (which is the
// operator's hand-authored file — programs shouldn't rewrite it). One tiny
// JsonStore; add keys as features need them.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "settings.json"), {
  // aria2 global speed caps, aria2-format strings ("0" = unlimited, "5M",
  // "500K", plain bytes). Re-applied on every daemon spawn — the daemon
  // restarts with a fixed arg list, so an unpersisted limit silently dies.
  aria2MaxDownload: "0",
  aria2MaxUpload: "0",
});

module.exports = store;
