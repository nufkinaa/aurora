// Sign-in answers even when the password check itself throws (scrypt fails
// when the machine is out of memory: "Deriving bits failed"). Under Express 4
// an async handler's throw is never answered, and the sign-in screen used to
// wait for ever. Stores are in-memory, as in auth.test.js.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const sessions = require("../src/lib/sessions");
const profiles = require("../src/profiles");
const settings = require("../src/lib/settings");
sessions._internals.store.save = () => {};
sessions._internals.store.data = {};
profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
settings.save = () => {};
const authRouter = require("../src/routes/auth");

test("a password check that throws is answered with a 500 and a plain message", async () => {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const real = profiles.login;
  const quiet = console.error;
  profiles.login = async () => { throw new Error("Deriving bits failed"); };
  console.error = () => {};
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ann", password: "whatever" }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /couldn't check that password/);
  } finally {
    profiles.login = real;
    console.error = quiet;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
