// Telemetry hygiene (src/lib/tel/scrub.js): what a client's message, address
// and stack frame are reduced to before anything is counted or stored — and
// that nothing personal or secret survives it. All samples are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const scrub = require("../src/lib/tel/scrub");

test("a message keeps what it says and loses what varies", () => {
  const n = scrub.normMessage;
  assert.equal(n("Cannot read properties of undefined (reading 'duration')"), "Cannot read properties of undefined (reading 'duration')");
  assert.equal(n("Request timed out after 30000 ms (attempt 3)"), "Request timed out after N ms (attempt N)");
  assert.equal(n("TypeError: x is not a function\n    at foo (http://h/js/a.js:1:2)"), "TypeError: x is not a function", "only the first line");
  // the same fault from two homes is one string
  assert.equal(n("Failed to fetch http://10.0.0.5:4000/api/item/3f9a2c1b7d4e"), n("Failed to fetch https://example.org/api/item/aa11bb22cc33"));
});

test("addresses, paths, ids, tokens, mail and quoted phrases never survive", () => {
  const n = scrub.normMessage;
  const cases = [
    ["Could not open \"The Example Film (1999)\"", "Could not open '…'"],
    ["Could not play 'Some Show' because of x", "Could not play '…' because of x"],
    ["ENOENT: no such file, open 'D:\\Movies\\The Example Film (1999)\\The Example Film.mkv'", "ENOENT: no such file, open '…'"],
    ["read failed D:\\Movies\\The Example Film (1999)\\The Example Film.mkv: EIO", "read failed <path>: EIO"],
    ["read failed /mnt/media/Shows/Some Show/Season 1/e01.mkv", "read failed <path>"],
    ["GET http://192.168.1.20:4000/img/3f9a2c1b7d4e?w=256 failed", "GET <url> failed"],
    ["peer 192.168.1.20:51413 refused", "peer <ip> refused"],
    ["mail anna.tester@example.com bounced", "mail <email> bounced"],
    ["token=abc123def456ghi789 rejected", "token=<redacted> rejected"],
    ["session: 9f8e7d6c5b4a3210 is dead", "session=<redacted> is dead"],
    ["Authorization: Bearer abcDEF123456.xyz", "Authorization=<redacted>"],
    ["bad jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", "bad jwt <token>"],
    ["title tt0133093 not found", "title <id> not found"],
    ["Some Show S02E05 failed", "Some Show <ep> failed"],
    ["job 3f9a2c1b7d4e-720 exited", "job <hex>-N exited"],
    ["id 550e8400-e29b-41d4-a716-446655440000 gone", "id <id> gone"],
    ["key AbCdEf0123456789XyZ0 leaked", "key <id> leaked"],
    ["שגיאה בטעינת הסרט", "…"],
    ["הסרט \"שם הסרט\" failed", "… '…' failed"],
  ];
  for (const [input, want] of cases) {
    const got = n(input);
    assert.equal(got, want, input);
    assert.equal(scrub.sensitive(got), null, `still sensitive: ${got}`);
  }
});

test("a quoted lower-case identifier is code and stays; anything else quoted goes", () => {
  const n = scrub.normMessage;
  assert.match(n("reading 'currentTime'"), /'currentTime'/);
  assert.match(n("undefined is not an object (evaluating 'a.b.c')"), /'a\.b\.c'/);
  assert.doesNotMatch(n("could not find 'Inception'"), /Inception/);
  assert.doesNotMatch(n("could not find 'the matrix'"), /matrix/);
});

test("a request address becomes its shape", () => {
  const p = scrub.urlPattern;
  assert.equal(p("http://10.0.0.5:4000/img/3f9a2c1b7d4e?w=256"), "/img/:id?w=256");
  assert.equal(p("/api/item/9af3c2d1e0b4?profile=anna"), "/api/item/:id?profile");
  assert.equal(p("/img/ext?u=https%3A%2F%2Fimages.example%2Fposter.jpg&w=256"), "/img/ext?u&w=256");
  assert.equal(p("/hls/abc123def456/720/seg-00012.ts"), "/hls/:id/:id/:file.ts");
  assert.equal(p("/api/search?q=the+example+film"), "/api/search?q", "the query's value never survives");
  assert.equal(p("/api/discover/meta/movie/tt0133093"), "/api/discover/meta/:id/:id");
  // a word that is not one of the server's own path words is treated as a name
  assert.equal(p("/api/inception/secret"), "/api/:id/:id");
  assert.equal(p("/img/:id?w=256"), "/img/:id?w=256", "already a shape: unchanged");
  // an unknown query key is dropped, a size's value is kept only when it is a small number
  assert.equal(p("/img/abc?w=99999999&name=anna"), "/img/:id?w");
  for (const u of ["/api/search?q=anna@example.com", "/api/item/tt0133093", "/stream/abcdef0123456789/The Example Film.mkv"]) assert.equal(scrub.sensitive(p(u)), null, u);
});

test("a location is a file and a function — never a line, a host or a version stamp", () => {
  const l = scrub.normLocation;
  assert.equal(l("screens/player.js:onStall"), "screens/player.js:onStall");
  assert.equal(l("http://10.0.0.5:4000/js/screens/player.js?v=ab12cd34:onStall:120:33"), "screens/player.js:onStall");
  assert.equal(l("screens/player.js:onStall < usage.js:flush"), "screens/player.js:onStall < usage.js:flush");
  assert.equal(l("screens/player.js:120:33"), "screens/player.js");
  assert.equal(l("../../etc/passwd; DROP"), "");
});

test("the fingerprint is the same for the same fault and different for another", () => {
  const fp = (app, kind, msg, loc) => scrub.fingerprint(app, kind, scrub.normMessage(msg), scrub.normLocation(loc));
  const a = fp("web", "js", "Request timed out after 30000 ms", "http://h/js/api.js?v=1:json:12:3");
  const b = fp("web", "js", "Request timed out after 45000 ms", "http://other/js/api.js?v=2:json:99:1");
  assert.equal(a, b, "numbers, hosts, versions and lines do not split a fingerprint");
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.notEqual(a, fp("tv", "js", "Request timed out after 30000 ms", "api.js:json"), "another app is another fingerprint");
  assert.notEqual(a, fp("web", "promise", "Request timed out after 30000 ms", "api.js:json"), "another kind too");
  assert.notEqual(a, fp("web", "js", "Request was refused", "api.js:json"));
});

test("the last gate: anything that still looks personal is replaced whole", () => {
  for (const s of ["see http://example.org/x", "anna@example.com", "10.0.0.5", "tt0133093", "0123456789abcdef0123", "C:\\Users\\anna\\x", "/home/anna/x", "שלום", "password: hunter2"]) {
    assert.ok(scrub.sensitive(s), s);
    assert.equal(scrub.safe(s), "<scrubbed>");
  }
  for (const s of ["GET /img/:id?w=256 → 401", "Cannot read properties of undefined (reading 'duration')", "token=<redacted> rejected", "…"]) assert.equal(scrub.sensitive(s), null, s);
  assert.equal(scrub.label("Xiaomi MiTV-MSSP3 (2021)", 32), "Xiaomi MiTV-MSSP3 (2021)");
  assert.equal(scrub.label("anna@example.com"), "", "a label that is somebody's address is no label");
  assert.equal(scrub.label("<script>alert(1)</script>"), "scriptalert(1)/script");
});
