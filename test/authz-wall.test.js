// The sign-in wall's "who is this?" — cookie and X-Session header together.
const test = require("node:test");
const assert = require("node:assert");

const sessions = require("../src/lib/sessions");
const profiles = require("../src/profiles");
const authz = require("../src/lib/authz");

const req = (cookie, header) => ({
  headers: {
    ...(cookie ? { cookie: `aurora_session=${cookie}` } : {}),
    ...(header ? { "x-session": header } : {}),
  },
});

test("a dead cookie does not shadow a live X-Session header (the TV with no pictures)", () => {
  const p = profiles.list().find((x) => !x.locked);
  if (!p) return; // no profiles on this machine: nothing to assert on
  const live = sessions.create(p.id, { ip: "test", device: "test" });
  try {
    assert.ok(authz.sessionFor(req(null, live)), "header alone");
    assert.ok(authz.sessionFor(req(live, null)), "cookie alone");
    assert.ok(authz.sessionFor(req("0".repeat(64), live)), "dead cookie + live header");
    assert.ok(authz.sessionFor(req(live, "0".repeat(64))), "live cookie + dead header");
    assert.equal(authz.sessionFor(req("0".repeat(64), "1".repeat(64))), null, "both dead");
    assert.equal(authz.sessionFor(req(null, null)), null, "neither");
  } finally {
    sessions.revoke(live);
  }
});
