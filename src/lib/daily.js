// The daily round: data Aurora fetches from the outside world goes stale
// (a crowd database gains an intro for last night's episode, a running show's
// rating moves, new art lands), so each such source registers a refresh here
// and it runs once a day.
//
// Last-run times are kept on disk (data/daily.json), so a restart neither
// skips a day nor re-runs everything at boot: a task is due when its last
// FINISHED run is ~a day old. Checked hourly; tasks run one after another,
// never two at once, so the refreshes never stack their requests on top of
// each other. A task that throws is retried at the next hourly check, not in
// a tight loop.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "daily.json"), {});
const DAY_MS = 24 * 3600 * 1000;
const DUE_MS = DAY_MS - 30 * 60 * 1000; // a little slack so the hourly check doesn't drift a day
const CHECK_MS = 60 * 60 * 1000;
const RETRY_MS = CHECK_MS;
const BOOT_DELAY_MS = 3 * 60 * 1000; // let boot, the first scan and enrichment settle

const tasks = new Map(); // name -> fn
let running = null; // name of the task in flight
let timer = null;

const rec = (name) => store.data[name] || (store.data[name] = {});

const due = (name, now = Date.now()) => {
  const r = store.data[name] || {};
  if (r.failedAt && now - r.failedAt < RETRY_MS) return false;
  return !r.at || now - r.at >= DUE_MS;
};

// `force` (the admin page's "run it now") runs every task whether or not it is due.
const tick = async (force = false) => {
  if (running) return;
  for (const [name, fn] of tasks) {
    if (!force && !due(name)) continue;
    running = name;
    const started = Date.now();
    try {
      const summary = await fn();
      const r = rec(name);
      r.at = Date.now();
      r.ms = r.at - started;
      r.summary = summary == null ? null : summary;
      delete r.failedAt;
      delete r.error;
      console.log(`[daily] ${name} refreshed in ${Math.round(r.ms / 1000)}s${summary ? ` — ${typeof summary === "string" ? summary : JSON.stringify(summary)}` : ""}`);
    } catch (e) {
      const r = rec(name);
      r.failedAt = Date.now();
      r.error = String((e && e.message) || e).slice(0, 200);
      console.warn(`[daily] ${name} failed: ${r.error}`);
    } finally {
      running = null;
      store.save();
    }
  }
};

// Register a refresh. `fn` is async and may return a short summary (string or
// small object) that the admin shows beside the last-run time.
const register = (name, fn) => {
  tasks.set(name, fn);
};

const start = () => {
  if (timer) return;
  const first = setTimeout(() => tick().catch(() => {}), BOOT_DELAY_MS);
  first.unref?.();
  timer = setInterval(() => tick().catch(() => {}), CHECK_MS);
  timer.unref?.();
};

// For the admin: each task's last run, what it did, and when it's next due.
const status = () =>
  [...tasks.keys()].map((name) => {
    const r = store.data[name] || {};
    return {
      name,
      lastRun: r.at || null,
      tookMs: r.ms || null,
      summary: r.summary || null,
      error: r.error || null,
      nextDue: r.at ? r.at + DUE_MS : null,
      running: running === name,
    };
  });

module.exports = { register, start, status, tick, _internals: { due, store, DUE_MS } };
