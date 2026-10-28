// The phone app is built from this codebase (docs/android-phone/PLAN.md) and
// must never change what the TV build is. These read the build files as text.
export {};
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8') as string;

test('no -Paurora: the TV app as it always was', () => {
  const g = read('android/app/build.gradle');
  // the TV's id, unconditionally; the phone's only behind the switch
  expect(g).toMatch(/applicationId "com\.auroratv"/);
  const phoneBlock = g.slice(g.indexOf('if (auroraPhone) {'), g.indexOf('if (auroraPhone) {') + 200);
  expect(phoneBlock).toMatch(/applicationId "com\.aurora\.phone"/);
  expect(g).toMatch(/def auroraPhone = String\.valueOf\(project\.findProperty\('aurora'\) \?: 'tv'\) == 'phone'/);
  expect(g).toMatch(/if \(auroraPhone\) entryFile = file\("\.\.\/\.\.\/index\.phone\.js"\)/);
});

test('the TV entry never imports the phone app, and the phone entry marks itself first', () => {
  expect(read('index.js')).not.toMatch(/phone/);
  expect(read('App.tsx')).not.toMatch(/['"]\.\/src\/phone/);
  const p = read('index.phone.js');
  const imports = p.split('\n').filter(l => /^import /.test(l));
  expect(imports[0]).toMatch(/\.\/src\/phone\/mark/);
  expect(p).toMatch(/registerComponent\('AuroraPhone'/);
});

test('the phone manifest claims nothing the TV app claims (both install side by side)', () => {
  const m = read('android/app/src/phone/AndroidManifest.xml');
  // fixed authorities would refuse the second install
  const auth = [...m.matchAll(/android:authorities="([^"]+)"/g)].map(x => x[1]);
  for (const a of auth) expect(a).toMatch(/^\$\{applicationId\}/);
  expect(m).not.toMatch(/LEANBACK_LAUNCHER|SearchProvider|HomeScreenJob|ArtProvider/);
  expect(m).toMatch(/\.PhoneActivity/);
  expect(m).toMatch(/supportsPictureInPicture="true"/);
});

test('the phone module is registered only in the phone build', () => {
  expect(read('android/app/src/main/java/com/auroratv/MainApplication.kt')).toMatch(/if \(BuildConfig\.PHONE\) add\(com\.auroratv\.phone\.PhonePackage\(\)\)/);
});

test('a QA address is never committed', () => {
  expect(read('src/api.ts')).not.toMatch(/QA VARIANT/);
});
