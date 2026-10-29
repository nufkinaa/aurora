// GET /.well-known/assetlinks.json — the Digital Asset Links statement that
// lets Android open this server's links in the Aurora phone app (App Links,
// package com.aurora.phone) instead of the browser. Served by Aurora itself,
// so a server needs no file copied into a web root by hand.
//
// Which certificate: the config's value first (AURORA_PHONE_CERT_SHA256 /
// "phoneCertSha256" in config.json — for a server that does not carry the
// APK, or a key that should be vouched for before a build is published),
// else the published public/aurora-phone.apk's own signing certificate
// (lib/apksign.js, cached per file). Neither → 404: no statement is better
// than a wrong one.
"use strict";
const path = require("path");
const apksign = require("./apksign");

const PACKAGE = "com.aurora.phone";
const APK_PATH = path.join(__dirname, "..", "..", "public", "aurora-phone.apk");

// PURE: whatever the config holds → the normalised fingerprints ("AB:CD:…"),
// the unreadable ones dropped. A string may hold several, comma-separated
// (or space-separated when each one is whole).
const fromConfig = (v) => {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
  const out = [];
  const add = (n) => { if (n && !out.includes(n)) out.push(n); };
  for (const p of parts) {
    const whole = apksign.normalise(p);
    if (whole) add(whole);
    else for (const tok of String(p || "").trim().split(/\s+/)) add(apksign.normalise(tok));
  }
  return out;
};

// → { fingerprints: [...], source: "config" | "apk" } or { error }
const fingerprints = ({ configured, apkPath = APK_PATH } = {}) => {
  let conf = configured;
  if (conf === undefined) { try { conf = require("../config").PHONE_CERT_SHA256; } catch { conf = null; } }
  const list = fromConfig(conf);
  if (list.length) return { fingerprints: list, source: "config" };
  const s = apksign.read(apkPath);
  if (s.sha256) return { fingerprints: [s.sha256], source: "apk" };
  return { error: "no Android phone app signing certificate is known: set AURORA_PHONE_CERT_SHA256 (or phoneCertSha256 in config.json), or publish public/aurora-phone.apk" };
};

// PURE: the statement itself.
const statement = (list) => [{
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: PACKAGE, sha256_cert_fingerprints: list },
}];

const handler = (req, res) => {
  let f;
  try { f = fingerprints(); } catch (e) { f = { error: String((e && e.message) || e) }; }
  res.setHeader("Cache-Control", "public, max-age=3600");
  if (f.error) return res.status(404).json({ error: f.error });
  res.type("application/json").send(JSON.stringify(statement(f.fingerprints)));
};

module.exports = { handler, fingerprints, statement, fromConfig, PACKAGE };
