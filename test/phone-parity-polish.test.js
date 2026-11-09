// Three gaps a device pass (2026-11-09) found between the phone app and the
// website / the TV — held here, across the trees, so they stay closed:
//
//  - Pick together's lobby: the website (screens/group.js codeBlock, phone
//    sizes too) and the TV show a QR code under the code; the phone said "Scan
//    the code with your phone…" and showed none.
//  - The AI page: the website's and the TV's offer "Pick together"; the
//    phone's did not.
//  - "Play on <TV>" on the phone's title page cut a long name off after two
//    lines ("Play on Xiaomi TV B…"); the website's round buttons wrap the whole name.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("Pick together's lobby: the QR code of the join address on the website, the TV and the phone", () => {
  const web = read("public/js/screens/group.js");
  assert.match(web, /qrSvg\(url/);
  assert.match(web, /G\.joinUrl\(location\.origin, code\)/);
  for (const f of ["tv-native/src/screens/GroupPick.tsx", "tv-native/src/phone/screens/GroupPick.tsx"]) {
    const src = read(f);
    assert.match(src, /from 'react-native-qrcode-svg'/, `${f} draws a QR code`);
    assert.match(src, /<QRCode value=\{joinUrl\(/, `${f}: the QR holds the join address`);
    assert.match(src, /WORDS\.joinLine/, `${f}: the line that asks to scan it`);
    assert.match(src, /hostOf\(/, `${f}: the server's address under it`);
  }
  // the website's block starts with "Join in"; so does the phone's
  assert.match(web, /el\("div", \{ class: "gp-code-kicker" \}, W\.joinTitle\)/);
  assert.match(read("tv-native/src/phone/screens/GroupPick.tsx"), /\{WORDS\.joinTitle\}/);
});

test("the AI page offers Pick together on the website, the TV and the phone, in the same words", () => {
  const web = read("public/js/screens/pickforme.js");
  assert.match(web, /"data-ui": "group\.open"[\s\S]{0,200}GROUP\.entry\)[\s\S]{0,120}GROUP\.entryLine/);
  for (const f of ["tv-native/src/screens/Pick.tsx", "tv-native/src/phone/screens/Pick.tsx"]) {
    const src = read(f);
    assert.match(src, /import \{WORDS as GROUP\} from '\.\.\/(\.\.\/)?groupPick'/, `${f} takes the shared words`);
    assert.match(src, /uiId="group\.open"[\s\S]{0,400}\{GROUP\.entry\}[\s\S]{0,200}\{GROUP\.entryLine\}/, `${f}: the entry and its line`);
  }
  assert.match(read("tv-native/src/phone/screens/Pick.tsx"), /navigation\.push\('GroupPick'\)/);
});

test("Play on <TV> on the phone's title page: the website's words, the whole name", () => {
  // the website: a round button whose word wraps (white-space: normal, no clamp)
  const css = read("public/css/glass.css");
  const rule = css.slice(css.indexOf("html:root .detail-hero .detail-actions-more .btn {"));
  assert.match(rule.slice(0, rule.indexOf("}")), /white-space: normal;/);
  const phone = read("tv-native/src/phone/screens/Detail.tsx");
  assert.match(phone, /uiId="phone\.detail\.playon"[^\n]*PLAY_ON\.buttonFor\(tvs\[0\]\.name\)[^\n]*lines=\{0\}/);
  const btn = read("tv-native/src/phone/ui/Buttons.tsx");
  assert.match(btn, /numberOfLines=\{lines\}/);
  // the server keeps a name to 40 characters, so "all it needs" stays a few lines
  assert.match(read("src/lib/devices.js"), /tidy\(m\.name, 40\)/);
});
