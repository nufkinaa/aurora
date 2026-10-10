// Web Push on a shared browser: the one subscription a browser has is filed
// under whoever is using it — on entering a profile, on switching, and taken
// off the server on signing out.
//
// No push is ever sent from here: the browser side is a stand-in (a
// subscription object with a made-up endpoint on a real push host's name),
// the page only ever files or withdraws that endpoint (it never asks for a
// test notification), and the private server cannot reach any other host.
const assert = require("node:assert/strict");
const { suite, waitForScreen } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    srv.profiles.ann = await srv.api.createProfile("Ann", { open: true });
    srv.profiles.ben = await srv.api.createProfile("Ben", { open: true });
    const p = await srv.api.createProfile("Cleo");
    await srv.api.post("/api/auth/claim", { profileId: p.id, username: "cleo" }, await srv.api.as(p));
    srv.profiles.cleo = { ...p, username: "cleo" };
  },
});

// A browser where notifications were switched on earlier: permission granted,
// a service-worker registration whose pushManager holds a subscription.
const browserWithPush = (page, endpoint) =>
  page.addInitScript((endpoint) => {
    try { localStorage.setItem("aurora-push", "1"); } catch {}
    const sub = { endpoint, unsubscribe: async () => true };
    const reg = { pushManager: { getSubscription: async () => sub, subscribe: async () => sub } };
    window.PushManager = window.PushManager || function PushManager() {};
    try { Object.defineProperty(Notification, "permission", { get: () => "granted" }); } catch {}
    try {
      Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => reg });
      Object.defineProperty(navigator.serviceWorker, "ready", { get: () => Promise.resolve(reg) });
    } catch {}
  }, endpoint);

// every POST the page makes to a profile's push route: { profile, body, answer }
const watchPush = (page) => {
  const calls = [];
  page.on("response", async (res) => {
    const m = /\/api\/profiles\/([^/]+)\/push$/.exec(new URL(res.url()).pathname);
    if (!m || res.request().method() !== "POST") return;
    let body = null;
    let answer = null;
    try { body = JSON.parse(res.request().postData() || "null"); } catch {}
    try { answer = await res.json(); } catch {}
    calls.push({ profile: m[1], body, answer, status: res.status() });
  });
  const wait = async (test, what) => {
    for (let i = 0; i < 100; i++) {
      const hit = calls.find(test);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}; push calls so far: ${JSON.stringify(calls)}`);
  };
  return { calls, wait };
};
// How many browsers the server has on file for a profile — asked the only way
// the API offers: file one more (a made-up second browser) and read the count.
const devicesOf = async (api, profile, n) =>
  (await api.post(`/api/profiles/${profile.id}/push`, { endpoint: `https://fcm.googleapis.com/fcm/send/ui-probe-${profile.id}-${n}` }, await api.as(profile))).devices - 1;

ui.test("switching profile on a shared browser moves its notifications to the new profile", async ({ page, goto, api, signIn, profiles }) => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/ui-test-shared-browser";
  await browserWithPush(page, endpoint);
  const push = watchPush(page);
  await signIn(profiles.ann);
  await goto("#/");

  // entering a profile files the browser under it
  const first = await push.wait((c) => c.profile === profiles.ann.id, "the subscription being filed under Ann");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { endpoint }, "only the endpoint: no test notification is asked for");
  assert.equal(await devicesOf(api, profiles.ann, 1), 1);

  // Ben takes the browser over
  await page.click("#nav-profile");
  await page.click('.nav-menu-item:has-text("Switch profile")');
  await page.click(`.profiles-gate .profile-tile[title="${profiles.ben.name}"]`);
  await page.waitForSelector(".profiles-gate", { state: "detached" });
  const moved = await push.wait((c) => c.profile === profiles.ben.id, "the subscription being filed under Ben");
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body, { endpoint });
  assert.equal(moved.answer.devices, 1);
  // and Ann no longer has this browser (her probe from above is her only one)
  assert.equal(await devicesOf(api, profiles.ann, 2), 1, "Ann still has the shared browser on file");
  assert.ok(push.calls.every((c) => !c.body.test), "the page asked for a test notification");
});

ui.test("a browser with notifications off files nothing", async ({ page, goto, signIn, profiles }) => {
  const push = watchPush(page);
  await signIn(profiles.ann);
  await goto("#/");
  await goto("#/movies");
  await page.waitForTimeout(600);
  assert.deepEqual(push.calls, []);
});

ui.test("signing out takes the browser's notifications off the profile", async ({ page, context, srv, goto, api, signIn, profiles }) => {
  const p = profiles.cleo;
  const endpoint = "https://fcm.googleapis.com/fcm/send/ui-test-cleo-browser";
  await browserWithPush(page, endpoint);
  const push = watchPush(page);
  // a signed-in browser: the session cookie and the profile it belongs to
  const login = await api.post("/api/auth/login", { username: p.username, password: p.password });
  await context.addCookies([{ name: "aurora_session", value: login.session, url: srv.url }]);
  await signIn(p);
  await goto("#/");
  await push.wait((c) => c.profile === p.id && c.body.on !== false, "the subscription being filed under Cleo");
  assert.equal(await devicesOf(api, p, 1), 1);

  await page.click("#nav-profile");
  await page.click('.nav-menu-item:has-text("Sign out")');
  const off = await push.wait((c) => c.profile === p.id && c.body.on === false, "the subscription being withdrawn");
  assert.equal(off.status, 200);
  assert.equal(off.body.endpoint, endpoint);
  // signed out: back at the wall (this server does not require sign-in)
  await page.waitForSelector(".profiles-gate");
  assert.equal((await api.get("/api/me", { "X-Session": login.session })).user, null, "the session is gone too");
  assert.equal(await devicesOf(api, p, 2), 1, "only the probe is left on file for Cleo");
  // the switch itself is still on for the next person in
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-push")), "1");
});

ui.run({ concurrency: 1 });
