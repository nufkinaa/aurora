// A global key handler never acts on the RELEASE of the press that moved
// focus to where it is now (src/focus.ts pressMovedFocus): JS hears a D-pad
// key when it comes up, Android moved focus when it went down, so a handler
// that asks "is focus on the top row / at the edge?" is answered about the
// place the press ARRIVED at — and one press moves twice (UP from the second
// row of Search's grid went through the top row and on to the pills).
//
// Every file that listens to the remote globally is listed here as guarded or
// as not needing it, with the reason. A new listener that is in neither list
// FAILS: decide which it is.
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');

const GUARDED = ['components/NavRail.tsx', 'screens/Browse.tsx', 'screens/Home.tsx', 'screens/MyList.tsx', 'screens/Pick.tsx', 'screens/Search.tsx'];
const EXEMPT: Record<string, string> = {
  'focus.ts': 'the hook itself',
  'playback/Player.tsx': 'acts on what was pressed, never on where focus is',
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, {withFileTypes: true}).flatMap((e: {name: string; isDirectory: () => boolean}) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'assets' ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

const listeners: Record<string, string> = {};
for (const file of walk(SRC)) {
  const text: string = fs.readFileSync(file, 'utf8');
  if (/\buseTV(?:Keys|EventHandler)\(/.test(text)) listeners[path.relative(SRC, file).split(path.sep).join('/')] = text;
}

test('every file that listens to the remote is listed', () => {
  const unlisted = Object.keys(listeners).filter(f => !GUARDED.includes(f) && !(f in EXEMPT));
  expect(unlisted).toEqual([]);
  const gone = [...GUARDED, ...Object.keys(EXEMPT)].filter(f => !(f in listeners));
  expect(gone).toEqual([]);
});

test('the guarded ones ask pressMovedFocus() in their handler', () => {
  for (const f of GUARDED) expect({f, guarded: /pressMovedFocus\(\)/.test(listeners[f])}).toEqual({f, guarded: true});
});

test('the sheets master added listen to nothing but OK and BACK', () => {
  const sheet: string = fs.readFileSync(path.join(SRC, 'components/PersonSheet.tsx'), 'utf8');
  expect(/useTV(?:Keys|EventHandler)\(/.test(sheet)).toBe(false);
});
