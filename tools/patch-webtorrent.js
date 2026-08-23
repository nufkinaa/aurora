// Null-guard two WebTorrent 3.0.16 piece-picker sites that crash under
// multi-peer load (a completed piece is set to null while still referenced,
// so `pieces[index].reserve()` / `.missing` throw and wedge streaming).
// Idempotent — safe to run on every install/start.
const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "node_modules", "webtorrent", "lib");
const file = path.join(LIB, "torrent.js");

let src;
try {
  src = fs.readFileSync(file, "utf-8");
} catch {
  process.exit(0); // webtorrent not installed (nothing to patch)
}

let changed = false;

const guardReserve =
  "    if (!piece) return false // AURORA-PATCH: piece completed/nulled — skip, don't crash\n" +
  "    let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()";
if (
  src.includes("let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()") &&
  !src.includes("AURORA-PATCH: piece completed/nulled — skip, don't crash\n    let reservation")
) {
  src = src.replace(
    "    const piece = self.pieces[index]\n    let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()",
    "    const piece = self.pieces[index]\n" + guardReserve
  );
  changed = true;
}

if (
  src.includes("        let missing = self.pieces[index].missing") &&
  !src.includes("skip, don't crash\n        let missing = self.pieces[index].missing")
) {
  src = src.replace(
    "        let missing = self.pieces[index].missing",
    "        if (!self.pieces[index]) return true // AURORA-PATCH: piece completed/nulled — skip, don't crash\n        let missing = self.pieces[index].missing"
  );
  changed = true;
}

// Third site: the `downloaded` getter (read by `.progress`, which the /status
// endpoint polls every second). A piece nulled the instant it completes — but
// before its bitfield bit flips — lands in the "in progress" branch and throws
// on `piece.length`. A nulled piece is a completed piece, so count it whole.
if (
  src.includes("        const piece = this.pieces[index]\n        downloaded += (piece.length - piece.missing)") &&
  !src.includes("AURORA-PATCH: piece completed/nulled — count whole")
) {
  src = src.replace(
    "        const piece = this.pieces[index]\n        downloaded += (piece.length - piece.missing)",
    "        const piece = this.pieces[index]\n" +
      "        if (!piece) { downloaded += (index === len - 1) ? this.lastPieceLength : this.pieceLength; continue } // AURORA-PATCH: piece completed/nulled — count whole\n" +
      "        downloaded += (piece.length - piece.missing)"
  );
  changed = true;
}

// ---------- torrent.js: peer-churn tuning ----------
// Measured 2026-08-23 (bench vs aria2 on the same swarm: 4.9 vs 16.1 MB/s,
// 20 vs 44 peers): webtorrent hangs up on any wire that hasn't unchoked us
// within 5s — but the standard BitTorrent rechoke round is 10s (webtorrent's
// own RECHOKE_INTERVAL says so), so healthy seeders get dropped before their
// first rechoke tick, burn their three reconnect retries, and are then
// discarded forever — with the next tracker refill 30 minutes away. Give
// wires three rechoke rounds before giving up, and keep retrying addresses
// long enough to bridge announce intervals.
if (
  src.includes("const CHOKE_TIMEOUT = 5_000") &&
  !src.includes("AURORA-PATCH: choke timeout")
) {
  src = src.replace(
    "const CHOKE_TIMEOUT = 5_000",
    "const CHOKE_TIMEOUT = 30_000 // AURORA-PATCH: choke timeout — 3 rechoke rounds, not half of one",
  );
  changed = true;
}
if (
  src.includes("const RECONNECT_WAIT = [1_000, 5_000, 15_000]") &&
  !src.includes("AURORA-PATCH: reconnect ladder")
) {
  src = src.replace(
    "const RECONNECT_WAIT = [1_000, 5_000, 15_000]",
    "const RECONNECT_WAIT = [1_000, 5_000, 15_000, 60_000, 180_000] // AURORA-PATCH: reconnect ladder bridges the 30-min announce gap",
  );
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, src);
  console.log("patched webtorrent piece-picker null guards + peer-churn tuning");
} else {
  console.log("webtorrent already patched (or layout changed)");
}

// ---------- peer.js: handshake() on a destroyed peer ----------
// Peer.destroy() nulls this.swarm, but a late wire 'crypto-handshake' callback
// still calls handshake(), which reads this.swarm.private with no guard (every
// other call site checks `if (this.swarm)`). Result: an unhandled TypeError
// "Cannot read properties of null (reading 'private')" whenever a peer is torn
// down mid-encryption-handshake — routine when dropping wires on a completed
// torrent. Guard it like the rest of the file does.
const peerFile = path.join(LIB, "peer.js");
try {
  let peerSrc = fs.readFileSync(peerFile, "utf-8");
  const needle = "  handshake () {\n    const opts = {";
  if (peerSrc.includes(needle) && !peerSrc.includes("AURORA-PATCH: peer destroyed")) {
    peerSrc = peerSrc.replace(
      needle,
      "  handshake () {\n" +
        "    if (!this.swarm || !this.wire) return // AURORA-PATCH: peer destroyed mid-handshake\n" +
        "    const opts = {"
    );
    fs.writeFileSync(peerFile, peerSrc);
    console.log("patched webtorrent peer handshake null guard");
  } else {
    console.log("webtorrent peer.js already patched (or layout changed)");
  }
} catch {}
