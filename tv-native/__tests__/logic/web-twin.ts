// Loads one of the website's small modules (public/js/…) as the plain script
// it is, so a TV port can be held to the website's own answers. Through Jest's
// require the file would be transformed, and babel's helpers do not resolve
// from the repo root where it lives (see home-merge.test.ts). Only for modules
// whose tested functions are pure: an `import {a, b} from "./x.js"` line
// becomes `const {a, b} = stubs` (give what the pure functions need).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

export const loadWeb = (rel: string, stubs: Record<string, unknown> = {}): Record<string, any> => {
  const file = path.join(__dirname, '../../../public/js', rel);
  let src: string = fs.readFileSync(file, 'utf8');
  const names: string[] = [];
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];?\s*$/gm, (_m, list: string) => `const {${list}} = __stubs;`);
  src = src.replace(/^export\s+(const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kind: string, name: string) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`web-twin: ${rel} has an import/export this loader does not know`);
  // eslint-disable-next-line no-new-func
  return new Function('__stubs', `${src}\nreturn {${names.join(', ')}};`)(stubs);
};

// A small seeded generator for drawn cases (mulberry32).
export const seeded = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
