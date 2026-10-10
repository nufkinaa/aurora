// The server's pass for its own loopback requests (lib/internalpass.js).
const test = require("node:test");
const assert = require("node:assert");
const pass = require("../src/lib/internalpass");

test("only the exact per-process value passes; anything else, or nothing, does not", () => {
  assert.equal(pass.ok({ headers: { [pass.HEADER]: pass.value } }), true);
  assert.equal(pass.ok({ headers: {} }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: "" } }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: "0".repeat(pass.value.length) } }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: pass.value + "0" } }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: [pass.value] } }), false);
  assert.equal(pass.ok(null), false);
  assert.match(pass.value, /^[0-9a-f]{64}$/);
});
