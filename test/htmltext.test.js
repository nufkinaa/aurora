// HTML-escaped catalogue text made plain where it enters (src/lib/htmltext.js): the swipe
// deck's line read "… with Josh O&apos;Connor" on the website and the TV (2026-10-18).
const test = require("node:test");
const assert = require("node:assert/strict");
const { plainText } = require("../src/lib/htmltext");
const wk = require("../src/media/wellknown");
const td = require("../src/media/tastedeck");

test("the entities that occur, named and numeric; anything else is left as it is", () => {
  assert.equal(plainText("Josh O&apos;Connor"), "Josh O'Connor");
  assert.equal(plainText("Tom &amp; Jerry &#39;n&#x27; &quot;friends&quot; &lt;3 &gt;_&lt;"), `Tom & Jerry 'n' "friends" <3 >_<`);
  assert.equal(plainText("Amélie&nbsp;Poulain &hellip;"), "Amélie Poulain …");
  assert.equal(plainText("AT&T &foo; & co &#0; &#xZZ;"), "AT&T &foo; & co &#0; &#xZZ;");
  assert.equal(plainText("plain"), "plain");
  assert.equal(plainText(null), null);
  assert.equal(plainText(undefined), undefined);
});

test("the well-known titles: names decoded as they are fetched, and an older file as it is read", () => {
  const rec = wk._internals.fromMeta({ id: "tt0000001", name: "Ocean&apos;s Eleven", poster: "p", cast: ["George Clooney", "Josh O&apos;Connor"], director: "Steven Soderbergh" }, "movie", 3);
  assert.equal(rec.title, "Ocean's Eleven");
  assert.deepEqual(rec.cast, ["George Clooney", "Josh O'Connor"]);
  const old = { imdbId: "tt0000002", type: "movie", title: "Schindler&#39;s List", cast: ["Liam Neeson", "Ralph Fiennes &amp; co"], director: ["Steven Spielberg"], k: 1 };
  const fine = { imdbId: "tt0000003", type: "movie", title: "Heat", cast: ["Al Pacino"], director: ["Michael Mann"], k: 2 };
  wk._internals.useStore({ data: { v: 1, at: 1, tried: 1, titles: [old, fine] }, save() {} });
  const all = wk.all();
  assert.equal(all[0].title, "Schindler's List");
  assert.deepEqual(all[0].cast, ["Liam Neeson", "Ralph Fiennes & co"]);
  assert.equal(all[1], fine, "an unchanged record is the same object");
  assert.equal(wk.all(), all, "decoded once per list");
  assert.equal(old.title, "Schindler&#39;s List", "the stored record is not mutated");
});

test("the swipe deck's line is plain text, whatever it was built from", () => {
  const { lineOf } = td._internals;
  assert.equal(lineOf({ director: ["Luca Guadagnino"], cast: ["Zendaya", "Josh O&apos;Connor"] }, null), "Luca Guadagnino, with Zendaya and Josh O'Connor");
  assert.equal(lineOf({ synopsis: "A tennis prodigy&apos;s marriage &amp; a rivalry turn into one long match." }, null), "A tennis prodigy's marriage & a rivalry turn into one long match.");
  assert.equal(lineOf({ imdbId: "tt1" }, () => "Rock &amp; roll never dies, says the band&#39;s drummer."), "Rock & roll never dies, says the band's drummer.");
});

// TVMaze's summaries are HTML with entities in them: "Georgie &amp; Mandy's
// First Marriage follows…" reached the website, the TV and the phone as
// written (elia's iPhone, 2026-11-10). The tags go and the entities are
// decoded wherever a TVMaze summary enters: the library's synopsis
// (online.js, and a synopsis kept from before as it is read), Discover's
// show search (discover.js) and X-Ray's episode overview (xray.js).
test("TVMaze summaries: tags stripped and entities decoded, library, Discover and X-Ray", () => {
  const online = require("../src/media/online");
  const discover = require("../src/media/discover");
  const xray = require("../src/media/xray");
  const html = "<p>Georgie &amp; Mandy&#39;s First Marriage follows <b>Georgie</b> and Mandy&hellip;</p>";
  const want = "Georgie & Mandy's First Marriage follows Georgie and Mandy…";
  assert.equal(online._internals.stripHtml(html), want);
  assert.equal(xray._internals.stripHtml(html), want);
  assert.equal(discover._internals.showItem({ name: "Georgie &amp; Mandy", summary: html }).synopsis, want);
  // kept before the fix: put right as it is read
  const store = online._internals.store;
  const key = "show|georgie & mandy's first marriage";
  const before = store.data[key];
  store.data[key] = { synopsis: "Georgie &amp; Mandy&#39;s First Marriage follows", genres: [], fetchedAt: 1 };
  try {
    assert.equal(online.get("show", "Georgie & Mandy's First Marriage").synopsis, "Georgie & Mandy's First Marriage follows");
  } finally {
    if (before === undefined) delete store.data[key]; else store.data[key] = before;
  }
});
