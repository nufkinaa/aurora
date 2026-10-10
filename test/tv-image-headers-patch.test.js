// The TV app's pictures carry the sign-in only because of a patch to React
// Native's Image.android.js (single-object sources dropped `headers` in 0.86;
// every picture went out with no X-Session and a closed server answered 401 —
// 5.1.27 and 5.1.30 both shipped that way). If the patch is ever lost in an
// upgrade, this fails before a release does.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("the React Native patch that forwards a single image source's headers is still in the TV app", () => {
  const dir = path.join(__dirname, "..", "tv-native", "patches");
  const files = fs.readdirSync(dir).filter((f) => /^react-native\+.*\.patch$/.test(f));
  assert.equal(files.length, 1, "one react-native patch file");
  const patch = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.match(patch, /Libraries\/Image\/Image\.android\.js/);
  assert.match(patch, /\+\s+headers: sourceHeaders,/);
  assert.match(patch, /\+\s+nativeProps\.headers = sourceHeaders;/);
});
