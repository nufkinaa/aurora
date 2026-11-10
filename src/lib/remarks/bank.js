// The remarks bank as one table (the lines themselves live in ./bank/*.js).
//
// Every kind has a short code; a line's id is `<code>-<n>`, n counting from 1
// in its list. Once a line has shipped its id is its name (the clients send
// back the ids they were shown), so a retired line becomes `null` in place
// and nothing is reordered.
"use strict";

const FILES = ["everyday", "calendar", "habits", "places", "kids", "roasts"];

// How long a filled-in field may be before its template is skipped (Home's
// remark must fit two lines of a 375 px phone hero: 64 characters at most).
const HOME_MAX = 64;
const ROAST_MAX = 140;
const FIELD_MAX = { title: 22, name: 22, genre: 12, n: 3, m: 3, day: 9 };
const ROAST_FIELD_MAX = { title: 40, name: 24, genre: 14, n: 5, m: 5, pct: 3, hour: 2, day: 9, date: 14, hours: 8 };

const KINDS = {};
const BY_ID = new Map();
const CODES = new Map();

for (const file of FILES) {
  const group = require(`./bank/${file}.js`);
  for (const [kind, def] of Object.entries(group)) {
    if (KINDS[kind]) throw new Error(`remarks: kind ${kind} twice`);
    if (CODES.has(def.code)) throw new Error(`remarks: code ${def.code} twice (${kind}, ${CODES.get(def.code)})`);
    CODES.set(def.code, kind);
    const entry = {
      kind,
      group: file,
      code: def.code,
      kids: !!def.kids,
      roast: !!def.roast,
      place: !!def.place,
      max: def.roast ? ROAST_MAX : HOME_MAX,
      fieldMax: def.roast ? ROAST_FIELD_MAX : FIELD_MAX,
      lines: def.lines.map((text, i) => (text == null ? null : { id: `${def.code}-${i + 1}`, text })),
    };
    KINDS[kind] = entry;
    for (const line of entry.lines) if (line) BY_ID.set(line.id, { kind, text: line.text });
  }
}

const ID_RE = /^[a-z][a-z0-9]{1,3}-\d{1,4}$/;

// Fill a template's {fields}. null when a field is missing or too long, or
// the result runs over the kind's cap. The first letter of the line and of
// each sentence is upper-cased (a genre word can open a line).
const fill = (template, fields, kindDef) => {
  let bad = false;
  const limits = kindDef.fieldMax;
  let out = template.replace(/\{([a-z]+)\}/g, (_, key) => {
    const v = fields && fields[key];
    if (v == null || v === "") { bad = true; return ""; }
    const s = String(v);
    if (s.length > (limits[key] || 22)) bad = true;
    return s;
  });
  if (bad) return null;
  out = out.replace(/(^|[.?] )([a-z])/g, (_, a, b) => a + b.toUpperCase());
  return out.length <= kindDef.max ? out : null;
};

module.exports = { KINDS, BY_ID, ID_RE, HOME_MAX, ROAST_MAX, FIELD_MAX, ROAST_FIELD_MAX, fill };
