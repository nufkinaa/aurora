// The artwork proxy's allow-list (/img/ext): exact hosts, https only — and the
// health endpoint's word on which hosts were added after TV builds shipped.
const test = require("node:test");
const assert = require("node:assert");

const { EXT_IMG_HOSTS, ADDED_HOSTS, extAllowed } = require("../src/lib/imghosts");

test("the hosts every client has always assumed are still allowed", () => {
  for (const h of [
    "image.tmdb.org",
    "images.metahub.space",
    "live.metahub.space",
    "static.tvmaze.com",
    "commons.wikimedia.org",
    "upload.wikimedia.org",
    "thumb.wikimedia.org",
  ]) {
    assert.ok(EXT_IMG_HOSTS.has(h), h);
    assert.equal(extAllowed(`https://${h}/a/b.jpg`), true, h);
  }
});

test("Cinemeta's episode stills are allowed", () => {
  assert.equal(extAllowed("https://episodes.metahub.space/tt0903747/1/1/w780.jpg"), true);
  // …and where they redirect to (checked hop by hop against the same list)
  assert.equal(extAllowed("https://image.tmdb.org/t/p/w780/88Z0fMP8a88EpQWMCs1593G0ngu.jpg"), true);
});

test("exact host, https only — nothing that merely looks like an allowed host", () => {
  for (const u of [
    "http://episodes.metahub.space/tt1/1/1/w780.jpg", // not https
    "https://episodes.metahub.space.evil.example/tt1/1/1/w780.jpg",
    "https://evil.example/episodes.metahub.space/x.jpg",
    "https://sub.episodes.metahub.space/x.jpg",
    "https://metahub.space/x.jpg",
    "https://episodes.metahub.space@evil.example/x.jpg", // userinfo trick
    "https://episodes.metahub.space:8443/x.jpg", // another port is another host
    "https://127.0.0.1/x.jpg",
    "https://localhost/x.jpg",
    "file:///etc/passwd",
    "",
    "not a url",
  ]) {
    assert.equal(extAllowed(u), false, u);
  }
  assert.equal(extAllowed(undefined), false);
  assert.equal(extAllowed(null), false);
});

test("every added host is on the list, and none is one of the old ones", () => {
  assert.deepEqual(ADDED_HOSTS, ["episodes.metahub.space"]);
  for (const h of ADDED_HOSTS) assert.ok(EXT_IMG_HOSTS.has(h));
  assert.equal(EXT_IMG_HOSTS.size, 8);
});

test("/api/ping lists the added hosts (the TV proxies them only when it sees them here)", () => {
  const router = require("../src/routes/auth");
  const layer = router.stack.find((l) => l.route && l.route.path === "/api/ping");
  assert.ok(layer, "the ping route exists");
  let body = null;
  layer.route.stack[0].handle({}, { json: (b) => (body = b) });
  assert.equal(body.ok, true);
  assert.equal(body.imgBlur, true);
  assert.deepEqual(body.imgHosts, ["episodes.metahub.space"]);
});
