#!/usr/bin/env node
// The recycling shelf and grid (src/poolMath.ts; docs/qa/native-bench/POOL-PLAN.md):
// the slot assignment proven here, on plain node, and written out as the expected
// values of the Kotlin twin's JVM test
// (android/app/src/main/java/com/auroratv/ui/pool/PoolMath.kt, tested by
// android/app/src/test/java/com/auroratv/ui/pool/PoolMathTest.kt).
//
// What is PROVEN before anything is written (a failure throws, no fixture):
//   shelf  - the pooled window is the reference window: `windowRange(anchor)` of
//            src/rowMath.ts, itself held to Row.tsx by tools/gen-row-fixtures.js;
//            with JS up to date the anchor is Row.tsx's own (`nextAnchor`);
//          - every item of a window has a slot of its own, and an item that is in
//            two consecutive windows is in the same slot in both;
//          - the focused card's slot is never rebound, and the focused card is in
//            every window that is committed — also when the anchor update runs
//            1..6 presses late (the deferred `setAnchor`), where the guard of
//            `poolAnchor` is what holds it;
//          - a slot is mounted or unmounted only when the window changes LENGTH
//            (the two ends of a shelf); every other move is rebinds only.
//   grid   - the window is always min(pool, rows) rows long, contains the focused
//            row, never rebinds the focused card's slot; with a constant item
//            count and full rows a move mounts and unmounts nothing.
//
// It also prints, per walk, what the device should count (POOL-PLAN.md §4): slots
// mounted / unmounted / rebound by the pool, against the cards the keyed window
// (today's NativeRow) mounts and unmounts over the same presses.
//
//   node tools/gen-pool-fixtures.js   → android/app/src/test/resources/pool-fixtures.json
'use strict';
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const load = rel => {
  const file = path.join(SRC, rel);
  const {code} = babel.transformFileSync(file, {babelrc: false, configFile: false, presets: ['module:@react-native/babel-preset']});
  const m = {exports: {}};
  new Function('module', 'exports', 'require', code)(m, m.exports, name => {
    throw new Error(`${rel} must not import anything (${name})`);
  });
  return m.exports;
};
const rowMath = load('rowMath.ts');
const P = load('poolMath.ts');

const fail = msg => {
  throw new Error(msg);
};
const must = (src, text, what) => {
  if (!src.includes(text)) fail(`${what} no longer contains: ${text}`);
};

// ---- the code this describes is still the code -------------------------------------------
const rowSrc = read('components/Row.tsx');
must(rowSrc, 'const POOL_SLOTS = poolSize(BEHIND, AHEAD);', 'Row.tsx (the pool size)');
must(rowSrc, 'slotItems(from, to, POOL_SLOTS)', 'Row.tsx (the slot assignment)');
must(rowSrc, 'poolAnchor(prev, index, latest.current, countRef.current, SLACK, BEHIND, AHEAD)', 'Row.tsx (the anchor)');
must(rowSrc, '<View key={slot} style={[styles.slot, {left: spacing.contentLeft + index * step}]}>', 'Row.tsx (the slot)');
const gridSrc = read('components/NativeGrid.tsx');
must(gridSrc, 'const POOL_ROWS = poolSize(GRID_BEHIND, GRID_AHEAD);', 'NativeGrid.tsx (the pool size)');
must(gridSrc, 'gridSlotItems(from, to, cols, count, POOL_ROWS)', 'NativeGrid.tsx (the slot assignment)');
must(gridSrc, 'gridAnchor(clampRow(prev, rowsRef.current), row, latestRow.current, rowsRef.current)', 'NativeGrid.tsx (the anchor)');
must(gridSrc, 'const clampRow = (anchor: number, rows: number) => Math.max(0, Math.min(anchor, rows - 1));', 'NativeGrid.tsx (the anchor clamp)');
must(gridSrc, 'gridWindow(clampRow(anchor, rows), rows)', 'NativeGrid.tsx (the window)');
must(gridSrc, '{left: (index % cols) * colPitch, top: Math.floor(index / cols) * rowPitch}', 'NativeGrid.tsx (the cell)');

const K = {
  behind: rowMath.VISIBLE_BEHIND,
  ahead: rowMath.VISIBLE_AHEAD,
  slack: rowMath.WINDOW_SLACK,
  pool: P.poolSize(rowMath.VISIBLE_BEHIND, rowMath.VISIBLE_AHEAD),
  gridBehind: P.GRID_BEHIND,
  gridAhead: P.GRID_AHEAD,
  gridSlack: P.GRID_SLACK,
  gridPoolRows: P.poolSize(P.GRID_BEHIND, P.GRID_AHEAD),
};
if (K.pool !== 9) fail(`the shelf pool is ${K.pool}, the plan and the comments say 9`);
// the anchor rule needs focus to stay inside the window between two moves
if (K.slack - 1 > K.behind || K.slack - 1 > K.ahead) fail('WINDOW_SLACK is wider than the window');
if (K.gridSlack - 1 > K.gridBehind || K.gridSlack - 1 > K.gridAhead) fail('GRID_SLACK is wider than the window');

const fx = {
  constants: K,
  slotOf: [],
  slotItems: [],
  poolAnchor: [],
  gridWindow: [],
  gridAnchor: [],
  gridSlotItems: [],
  gridIndexOf: [],
  paintOrder: [],
  walks: [],
};
const seenKey = new Set();
const once = (list, key, value) => {
  const k = list === fx.slotItems ? 's' + key : list === fx.poolAnchor ? 'a' + key : list === fx.gridWindow ? 'w' + key : list === fx.gridAnchor ? 'g' + key : 'x' + key;
  if (seenKey.has(k)) return;
  seenKey.add(k);
  list.push(value);
};

// A small deterministic generator (the fixtures must not change between runs).
let seed = 20261010;
const rnd = n => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};

for (const pool of [1, 6, 9, 48]) for (const i of [-10, -1, 0, 1, 8, 9, 10, 17, 18, 47, 48, 500]) fx.slotOf.push({index: i, pool, slot: P.slotOf(i, pool)});

// ---- the shelf -----------------------------------------------------------------------------
//
// One press = one step. The focus may only move onto a card that is MOUNTED (the track's
// focus guide traps at the window's ends), which is what makes the walks below the real
// ones: `want` is where the viewer is trying to go, the focus follows as far as the
// committed window lets it.
//
// `lag` models the deferred `setAnchor`: the update queued by press t runs after press
// t + lag has been handled, reading `latest` = the focus at that moment.
function shelfWalk(name, count, wants, lag) {
  let anchor = 0;
  let focus = 0;
  let win = rowMath.windowRange(anchor, count);
  let slots = P.slotItems(win.from, win.to, K.pool);
  const queue = []; // [dueAt, index]
  const tally = {presses: 0, moves: 0, mount: 0, unmount: 0, rebind: 0, keyedMount: 0, keyedUnmount: 0, held: 0};
  const steps = [];
  // the first render
  tally.mount += slots.filter(i => i >= 0).length;
  tally.keyedMount += win.to - win.from;
  const firstMount = tally.mount;
  for (let t = 0; t < wants.length; t++) {
    const want = Math.max(0, Math.min(count - 1, wants[t]));
    // the platform moves focus one card toward `want`, if that card is mounted
    const next = want > focus ? focus + 1 : want < focus ? focus - 1 : focus;
    if (next !== focus && next >= win.from && next < win.to) focus = next;
    tally.presses++;
    queue.push([t + lag, focus]);
    // the updates that are due, in order, all reading the same `latest`
    let moved = false;
    while (queue.length && queue[0][0] <= t) {
      const [, index] = queue.shift();
      const ref = rowMath.nextAnchor(anchor, index);
      const got = P.poolAnchor(anchor, index, focus, count, K.slack, K.behind, K.ahead);
      once(fx.poolAnchor, [anchor, index, focus, count].join(), {prev: anchor, index, latest: focus, count, next: got});
      if (lag === 0 && got !== ref) fail(`${name}: with JS up to date the anchor must be Row.tsx's (${got} vs ${ref})`);
      if (got !== ref) tally.held++;
      if (got !== anchor) moved = true;
      anchor = got;
    }
    if (moved) {
      const w = rowMath.windowRange(anchor, count);
      const s = P.slotItems(w.from, w.to, K.pool);
      once(fx.slotItems, [w.from, w.to, K.pool].join(), {from: w.from, to: w.to, pool: K.pool, slots: s});
      // every item of the window has exactly one slot
      const items = s.filter(i => i >= 0).sort((a, b) => a - b);
      if (items.length !== w.to - w.from || items.some((v, k) => v !== w.from + k)) fail(`${name}: window [${w.from},${w.to}) is not what the slots show: ${s}`);
      if (focus < w.from || focus >= w.to) fail(`${name}: press ${t}: the focused card ${focus} is outside the committed window [${w.from},${w.to})`);
      for (let k = 0; k < K.pool; k++) {
        const a = slots[k];
        const b = s[k];
        if (a === b) continue;
        if (a === focus) fail(`${name}: press ${t}: the focused card's slot ${k} was rebound (${a} → ${b})`);
        if (a < 0) tally.mount++;
        else if (b < 0) tally.unmount++;
        else tally.rebind++;
      }
      // an item in both windows did not change slot
      for (let i = Math.max(w.from, win.from); i < Math.min(w.to, win.to); i++) {
        if (slots.indexOf(i) !== s.indexOf(i)) fail(`${name}: item ${i} changed slot`);
      }
      // mounts and unmounts only when the window changed length
      const grew = w.to - w.from - (win.to - win.from);
      const mounted = s.filter((b, k) => slots[k] < 0 && b >= 0).length;
      const unmounted = s.filter((b, k) => slots[k] >= 0 && b < 0).length;
      if (mounted !== Math.max(0, grew) || unmounted !== Math.max(0, -grew)) fail(`${name}: press ${t}: ${mounted} mounted / ${unmounted} unmounted for a window that grew by ${grew}`);
      // the keyed window (today's NativeRow): every card that entered is mounted, every card that left unmounted
      for (let i = w.from; i < w.to; i++) if (i < win.from || i >= win.to) tally.keyedMount++;
      for (let i = win.from; i < win.to; i++) if (i < w.from || i >= w.to) tally.keyedUnmount++;
      tally.moves++;
      win = w;
      slots = s;
    }
    steps.push([focus, anchor, win.from, win.to]);
  }
  tally.mount -= firstMount;
  tally.keyedMount -= firstMount;
  fx.walks.push({kind: 'shelf', name, count, lag, steps, tally});
  return tally;
}

const report = [];
const right = n => Array.from({length: n}, () => 1e9);
const left = n => Array.from({length: n}, () => 0);
for (const count of [1, 2, 4, 6, 7, 9, 10, 13, 16, 40]) {
  for (const lag of [0, 1, 2, 3, 6]) {
    const walks = {
      'hold-right': right(count + 3),
      'right-then-left': [...right(count + 3), ...left(count + 3)],
      'hold-right-12': right(12),
      'dither': [1e9, 1e9, 1e9, 0, 1e9, 1e9, 1e9, 1e9, 0, 0, 0, 0, 0, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 0, 0, 1e9, 0, 1e9, 0, 0, 0, 0, 0, 0],
      'reversals': Array.from({length: 120}, (_, i) => (Math.floor(i / (2 + (i % 7))) % 2 ? 0 : 1e9)),
      'random': Array.from({length: 400}, () => (rnd(3) === 0 ? 0 : 1e9)),
      'random-even': Array.from({length: 400}, () => (rnd(2) === 0 ? 0 : 1e9)),
    };
    for (const [name, wants] of Object.entries(walks)) {
      const t = shelfWalk(`${name}-${count}-lag${lag}`, count, wants, lag);
      if (lag === 0 && (count === 40 || count === 16) && (name === 'hold-right' || name === 'hold-right-12' || name === 'right-then-left')) {
        report.push(`shelf ${name} n=${count}: ${t.presses} presses, ${t.moves} window moves — pool mounts ${t.mount} / unmounts ${t.unmount} / rebinds ${t.rebind}; keyed window mounts ${t.keyedMount} / unmounts ${t.keyedUnmount}`);
      }
    }
  }
}
// edge windows not reached by a walk
for (const [from, to] of [[0, 0], [0, 1], [0, 6], [0, 9], [3, 12], [31, 40], [37, 40], [100, 109]]) {
  once(fx.slotItems, [from, to, K.pool].join(), {from, to, pool: K.pool, slots: P.slotItems(from, to, K.pool)});
}
// the guard, stated outright: a move whose window would drop `latest` is refused
for (const [prev, index, latest, count] of [[10, 13, 9, 40], [10, 13, 10, 40], [10, 7, 13, 40], [10, 7, 12, 40], [0, 3, 0, 40], [0, 3, 5, 40], [20, 25, 21, 40], [20, 25, 22, 40], [38, 35, 39, 40]]) {
  const next = P.poolAnchor(prev, index, latest, count, K.slack, K.behind, K.ahead);
  const w = rowMath.windowRange(next, count);
  if (latest < w.from || latest >= w.to) fail(`poolAnchor(${prev}, ${index}, ${latest}) = ${next} drops the focused card`);
  once(fx.poolAnchor, [prev, index, latest, count].join(), {prev, index, latest, count, next});
}

// ---- the grid ------------------------------------------------------------------------------
//
// `wants` are rows; the column does not matter to the window (a horizontal move stays in the
// row). `counts[t]` is the item count at press t, so a page can land mid-walk.
function gridWalk(name, cols, counts, wants, lag) {
  const poolRows = K.gridPoolRows;
  let count = counts[0];
  let rows = P.gridRows(count, cols);
  let anchor = 0;
  let focusRow = 0;
  const col = cols - 1; // the last column: the first to be missing from a short last row
  let win = P.gridWindow(anchor, rows);
  let slots = P.gridSlotItems(win.from, win.to, cols, count, poolRows);
  const queue = [];
  const tally = {presses: 0, moves: 0, mount: 0, unmount: 0, rebind: 0};
  const steps = [];
  const commit = (t, why) => {
    const w = P.gridWindow(anchor, rows);
    once(fx.gridWindow, [anchor, rows].join(), {anchor, rows, from: w.from, to: w.to});
    const s = P.gridSlotItems(w.from, w.to, cols, count, poolRows);
    once(fx.gridSlotItems, [w.from, w.to, cols, count].join(), {fromRow: w.from, toRow: w.to, cols, count, poolRows, slots: s});
    if (w.to - w.from !== Math.min(poolRows, rows)) fail(`${name}: the window [${w.from},${w.to}) is not min(pool, rows) long`);
    if (rows > 0 && (focusRow < w.from || focusRow >= w.to)) fail(`${name}: press ${t} (${why}): the focused row ${focusRow} is outside [${w.from},${w.to})`);
    const focusItem = Math.min(count - 1, focusRow * cols + col);
    const want = [];
    for (let i = w.from * cols; i < Math.min(count, w.to * cols); i++) want.push(i);
    const got = s.filter(i => i >= 0).sort((a, b) => a - b);
    if (got.length !== want.length || got.some((v, k) => v !== want[k])) fail(`${name}: the slots do not show rows [${w.from},${w.to})`);
    let mounted = 0;
    let unmounted = 0;
    for (let k = 0; k < s.length; k++) {
      const a = slots[k];
      const b = s[k];
      if (a === b) continue;
      if (a === focusItem) fail(`${name}: press ${t} (${why}): the focused card's slot ${k} was rebound (${a} → ${b})`);
      if (a < 0) mounted++;
      else if (b < 0) unmounted++;
      else tally.rebind++;
    }
    for (let i = Math.max(w.from, win.from) * cols; i < Math.min(count, Math.min(w.to, win.to) * cols); i++) {
      if (slots.indexOf(i) >= 0 && slots.indexOf(i) !== s.indexOf(i)) fail(`${name}: item ${i} changed slot`);
    }
    tally.mount += mounted;
    tally.unmount += unmounted;
    win = w;
    slots = s;
    return {mounted, unmounted};
  };
  for (let t = 0; t < wants.length; t++) {
    if (counts[Math.min(t, counts.length - 1)] !== count) {
      // a page landed (or the list shrank): same anchor, new count
      const before = {count, rows};
      count = counts[Math.min(t, counts.length - 1)];
      rows = P.gridRows(count, cols);
      if (focusRow > rows - 1) focusRow = Math.max(0, rows - 1); // the focused card is gone: focus falls back (Browse's own fallback)
      // NativeGrid clamps the anchor it uses to the grid it has
      anchor = Math.max(0, Math.min(anchor, rows - 1));
      const {mounted, unmounted} = commit(t, 'count');
      // A page landing while the pool is full costs at most the two short rows involved: the old last
      // row is filled (up to cols - 1 slots mounted) and, when the window was held back by the end of
      // the grid and now slides, the new short last row may come into it (up to cols - 1 unmounted).
      if (before.rows >= K.gridPoolRows && rows >= K.gridPoolRows && (mounted > cols - 1 || unmounted > cols - 1)) {
        fail(`${name}: a count change under a full pool mounted ${mounted} / unmounted ${unmounted}`);
      }
    }
    const want = Math.max(0, Math.min(rows - 1, wants[t]));
    const next = want > focusRow ? focusRow + 1 : want < focusRow ? focusRow - 1 : focusRow;
    if (next !== focusRow && next >= win.from && next < win.to) focusRow = next;
    tally.presses++;
    queue.push([t + lag, focusRow]);
    let moved = false;
    while (queue.length && queue[0][0] <= t) {
      const [, row] = queue.shift();
      const ref = Math.abs(row - anchor) >= K.gridSlack ? row : anchor;
      const got = P.gridAnchor(anchor, row, focusRow, rows);
      once(fx.gridAnchor, [anchor, row, focusRow, rows].join(), {prev: anchor, row, latestRow: focusRow, rows, next: got});
      if (lag === 0 && got !== ref) fail(`${name}: with JS up to date the anchor follows the plain rule`);
      if (got !== anchor) moved = true;
      anchor = got;
    }
    if (moved) {
      const fullBefore = count % cols === 0 || win.to < rows;
      const {mounted, unmounted} = commit(t, 'move');
      const fullAfter = count % cols === 0 || win.to < rows;
      // full rows before and after: nothing is mounted or unmounted, whatever the move
      if (fullBefore && fullAfter && (mounted || unmounted)) fail(`${name}: press ${t}: a move between full windows mounted ${mounted} / unmounted ${unmounted}`);
      // a short last row costs at most the cards it lacks
      if (mounted > cols - 1 || unmounted > cols - 1) fail(`${name}: press ${t}: ${mounted} / ${unmounted} is more than one short row`);
      tally.moves++;
    }
    steps.push([focusRow, anchor, win.from, win.to]);
  }
  fx.walks.push({kind: 'grid', name, cols, counts: [...new Set(counts)], lag, steps, tally});
  return tally;
}
const down = n => Array.from({length: n}, () => 1e9);
const up = n => Array.from({length: n}, () => 0);
for (const cols of [3, 6, 8]) {
  for (const lag of [0, 1, 2, 3, 6]) {
    for (const count of [1, cols, cols * 3 - 1, cols * 8, cols * 8 + 1, cols * 20, cols * 20 + 2, 120]) {
      const rows = Math.ceil(count / cols);
      const walks = {
        'hold-down': down(rows + 2),
        'down-then-up': [...down(rows + 2), ...up(rows + 2)],
        'dither': [1e9, 1e9, 0, 1e9, 1e9, 1e9, 0, 0, 0, 1e9, 1e9, 1e9, 1e9, 0, 1e9, 0, 0, 0, 0, 0],
        'random': Array.from({length: 300}, () => (rnd(3) === 0 ? 0 : 1e9)),
      };
      for (const [name, wants] of Object.entries(walks)) {
        const t = gridWalk(`${name}-c${cols}-n${count}-lag${lag}`, cols, [count], wants, lag);
        if (lag === 0 && cols === 6 && count === 120 && name !== 'random' && name !== 'dither') {
          report.push(`grid ${name} cols=6 n=120: ${t.presses} presses, ${t.moves} window moves — pool mounts ${t.mount} / unmounts ${t.unmount} / rebinds ${t.rebind}`);
        }
      }
    }
    // paging: pages of 20 land while the viewer holds DOWN (Browse appends; 20 is not a multiple of 6)
    const pages = [60, 80, 100, 120, 140];
    const counts = Array.from({length: 40}, (_, t) => pages[Math.min(pages.length - 1, Math.floor(t / 7))]);
    const t = gridWalk(`paging-c${cols}-lag${lag}`, cols, counts, down(40), lag);
    if (lag === 0 && cols === 6) report.push(`grid hold-down with pages of 20 landing (60 → 140), cols=6: ${t.presses} presses, ${t.moves} window moves — pool mounts ${t.mount} / unmounts ${t.unmount} / rebinds ${t.rebind}`);
    // the library shelf of the grid shrinks under the viewer (a filter that keeps the grid mounted)
    gridWalk(`shrink-c${cols}-lag${lag}`, cols, Array.from({length: 30}, (_, t) => (t < 15 ? 120 : 30)), down(30), lag);
  }
}
for (const [anchor, rows] of [[0, 0], [0, 1], [0, 8], [5, 8], [0, 20], [3, 20], [4, 20], [19, 20], [16, 20], [15, 20]]) {
  const w = P.gridWindow(anchor, rows);
  once(fx.gridWindow, [anchor, rows].join(), {anchor, rows, from: w.from, to: w.to});
}

// The cell's edges as the native view reads them: Yoga rounds the dp position to the pixel
// grid, the view divides by the density again (as gen-row-fixtures.js does for a shelf).
const cardSrc = read('components/Card.tsx');
const num = (src, re, what) => {
  const m = src.match(re);
  if (!m) fail(`cannot find ${what}`);
  return Number(m[1]);
};
const CARD_W = num(cardSrc, /\bCARD_W = (\d+)/, 'CARD_W');
const CARD_H = num(cardSrc, /\bCARD_H = (\d+)/, 'CARD_H');
const GRID_GAP = num(read('screens/Browse.tsx'), /\nconst GRID_GAP = (\d+);/, 'GRID_GAP');
const colPitch = CARD_W + GRID_GAP;
const rowPitch = CARD_H + GRID_GAP;
fx.constants.colPitch = colPitch;
fx.constants.rowPitch = rowPitch;
const yogaPx = (dp, density) => Math.floor(dp * density + 0.5);
for (const density of [1, 1.5, 2, 3]) {
  for (const cols of [3, 6]) {
    for (const index of [0, 1, cols - 1, cols, cols * 2 + 1, cols * 7 + cols - 1, 119]) {
      for (const off of [-3, 0, 3]) {
        const left = yogaPx((index % cols) * colPitch + off, density) / density;
        const top = yogaPx(Math.floor(index / cols) * rowPitch + off, density) / density;
        const got = P.gridIndexOf(left, top, colPitch, rowPitch, cols, 120);
        if (got !== index) fail(`gridIndexOf(${left}, ${top}) @${density} = ${got}, not ${index}`);
        fx.gridIndexOf.push({density, left, top, colPitch, rowPitch, cols, count: 120, index});
      }
    }
  }
}
for (const [left, top, cols, count, index] of [[-50, -50, 6, 120, 0], [5000, 0, 6, 120, 5], [0, 99999, 6, 120, 119], [137, 199, 6, 8, 7], [274, 199, 6, 8, 7], [0, 0, 6, 0, 0]]) {
  const got = P.gridIndexOf(left, top, colPitch, rowPitch, cols, count);
  if (got !== index) fail(`gridIndexOf clamp (${left}, ${top}, ${count}) = ${got}, not ${index}`);
  fx.gridIndexOf.push({density: 1, left, top, colPitch, rowPitch, cols, count, index});
}

// Paint order: the slots of a window, in slot order, must be painted in item order.
const paintCase = (name, tops, lefts, expectItems, items) => {
  const order = P.paintOrder(tops, lefts);
  if (expectItems) {
    const painted = order.map(k => items[k]);
    if (painted.some((v, k) => k > 0 && v < painted[k - 1])) fail(`paintOrder ${name}: not item order: ${painted}`);
  }
  fx.paintOrder.push({name, tops, lefts, order});
};
for (const [from, to] of [[0, 6], [0, 9], [3, 12], [6, 15], [31, 40], [35, 40]]) {
  const s = P.slotItems(from, to, K.pool).filter(i => i >= 0); // children: the filled slots, in slot order
  paintCase(`shelf-${from}-${to}`, s.map(() => 0), s.map(i => 84 + i * 138), true, s);
}
for (const [from, to, cols, count] of [[0, 8, 6, 120], [2, 10, 6, 120], [7, 15, 6, 120], [12, 20, 6, 118], [0, 3, 6, 14]]) {
  const s = P.gridSlotItems(from, to, cols, count, K.gridPoolRows).filter(i => i >= 0);
  paintCase(`grid-${from}-${to}-${count}`, s.map(i => Math.floor(i / cols) * rowPitch), s.map(i => (i % cols) * colPitch), true, s);
}
paintCase('ties-keep-child-order', [5, 5, 5, 0], [7, 7, 3, 9], false, null);
paintCase('empty', [], [], false, null);

// The walks are the proof, not the fixture: only their tallies are kept.
fx.walks = fx.walks.map(w => ({kind: w.kind, name: w.name, lag: w.lag, tally: w.tally}));

const out = path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources', 'pool-fixtures.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(fx) + '\n');
console.log(`wrote ${out}: ${fx.walks.length} walks proven; ${fx.slotItems.length} windows, ${fx.poolAnchor.length} anchors, ${fx.gridWindow.length} grid windows, ${fx.gridAnchor.length} grid anchors, ${fx.gridSlotItems.length} grid slot maps, ${fx.gridIndexOf.length} cells, ${fx.paintOrder.length} paint orders`);
console.log('constants', JSON.stringify(fx.constants));
for (const line of new Set(report)) console.log(line);
