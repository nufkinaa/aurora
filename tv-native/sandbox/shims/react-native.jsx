// `react-native` as the sandbox sees it: react-native-web, plus the handful of
// things the TV app takes from react-native-tvos that the web build does not
// have — a d-pad (arrow keys moving focus by geometry, the way Android's focus
// search does), TVFocusGuideView's traps and autoFocus, useTVEventHandler,
// requestTVFocus, hasTVPreferredFocus and a BackHandler that hears Escape.
//
// This is a stand-in for looking at LAYOUT. It lays out with the browser's
// flexbox rather than Yoga and draws with Chrome rather than Android, so it is
// close, not identical — and focus order here is this file's guess at what
// Android would pick, good enough to walk the screens, not a proof.
import * as React from 'react';
import * as RNW from 'react-native-web';

export * from 'react-native-web';

// ---------- the remote ----------
const tvHandlers = new Set();
const backHandlers = [];

const emit = eventType => {
  for (const h of [...tvHandlers]) {
    try {
      h({eventType, eventKeyAction: 0});
    } catch (e) {
      console.error(e);
    }
  }
};

export const useTVEventHandler = handler => {
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => {
    const f = e => ref.current && ref.current(e);
    tvHandlers.add(f);
    return () => {
      tvHandlers.delete(f);
    };
  }, []);
};
export const TVEventHandler = {
  addListener: f => {
    tvHandlers.add(f);
    return {remove: () => tvHandlers.delete(f)};
  },
};
export const TVEventControl = {enableTVMenuKey() {}, disableTVMenuKey() {}, enableTVPanGesture() {}, disableTVPanGesture() {}};

export const BackHandler = {
  addEventListener(_name, fn) {
    backHandlers.push(fn);
    return {
      remove() {
        const i = backHandlers.indexOf(fn);
        if (i >= 0) backHandlers.splice(i, 1);
      },
    };
  },
  removeEventListener(_name, fn) {
    const i = backHandlers.indexOf(fn);
    if (i >= 0) backHandlers.splice(i, 1);
  },
  exitApp() {
    console.log('[sandbox] BackHandler.exitApp() — the app would close here');
  },
};

const goBack = () => {
  // newest subscriber first, like Android; the first to return true owns it
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    try {
      if (backHandlers[i]()) return;
    } catch (e) {
      console.error(e);
    }
  }
  // nobody claimed it: the navigator pops (entry.jsx wires this)
  if (typeof window.__tvBack === 'function') window.__tvBack();
};

// ---------- focus search ----------
const visible = el => {
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
  if (el.closest('[aria-hidden="true"],[inert]')) return false;
  return true;
};
const focusables = (root = document) =>
  [...root.querySelectorAll('[tabindex="0"],input:not([tabindex="-1"]),textarea:not([tabindex="-1"])')].filter(visible);

const guidesOf = el => {
  const out = [];
  for (let g = el && el.closest('[data-tvguide]'); g; g = g.parentElement && g.parentElement.closest('[data-tvguide]')) out.push(g);
  return out;
};

const pick = (from, dir) => {
  const a = from.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  // a guide that traps this direction keeps the search inside itself
  let scope = document;
  for (const g of guidesOf(from)) {
    if (g.dataset['trap' + dir] === '1') {
      scope = g;
      break;
    }
  }
  let best = null;
  let bestScore = Infinity;
  for (const el of focusables(scope)) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    // how far ahead it is, along the direction of travel
    const ahead =
      dir === 'right' ? b.left - a.right : dir === 'left' ? a.left - b.right : dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
    const cA = horizontal ? a.left + a.width / 2 : a.top + a.height / 2;
    const cB = horizontal ? b.left + b.width / 2 : b.top + b.height / 2;
    const forward = dir === 'right' || dir === 'down' ? cB > cA + 1 : cB < cA - 1;
    if (!forward || ahead < -Math.min(horizontal ? a.width : a.height, horizontal ? b.width : b.height) * 0.5) continue;
    // sideways miss: zero when the two overlap on the cross axis (the "beam")
    const lo = horizontal ? Math.max(a.top, b.top) : Math.max(a.left, b.left);
    const hi = horizontal ? Math.min(a.bottom, b.bottom) : Math.min(a.right, b.right);
    const miss = Math.max(0, lo - hi);
    // among equals, the one that lines up with where this one STARTS (its top
    // for a sideways move, its left edge for up/down): Down from a wide text
    // box lands on the button under its left end, not the one under its middle
    const drift = Math.abs(horizontal ? b.top - a.top : b.left - a.left);
    // in the beam always beats out of it; then nearest; then least sideways
    const score = (miss > 0 ? 100000 + miss * 4 : 0) + Math.max(0, ahead) + drift * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return null;
  // entering an autoFocus guide lands on where focus last was inside it
  const entered = guidesOf(best).filter(g => g.dataset.autofocus === '1' && !g.contains(from));
  const g = entered[entered.length - 1];
  if (g) {
    const last = g.__tvLast;
    if (last && g.contains(last) && visible(last)) return last;
    const pref = focusables(g).find(el => el.dataset.tvpref === '1');
    if (pref) return pref;
  }
  return best;
};

// Android scrolls a focused view into sight. Done by hand rather than with
// scrollIntoView, which would also scroll the sandbox page this frame sits in.
const reveal = el => {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const sy = /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
    const sx = /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
    if (!sy && !sx) continue;
    const r = el.getBoundingClientRect();
    const c = p.getBoundingClientRect();
    const pad = 24;
    if (sy) {
      if (r.bottom > c.bottom - pad) p.scrollTop += r.bottom - (c.bottom - pad);
      else if (r.top < c.top + pad) p.scrollTop -= c.top + pad - r.top;
    }
    if (sx) {
      if (r.right > c.right - pad) p.scrollLeft += r.right - (c.right - pad);
      else if (r.left < c.left + pad) p.scrollLeft -= c.left + pad - r.left;
    }
  }
};

// WHO HAS FOCUS is kept here, not read from the browser. A browser gives real
// focus (and its focus/blur events, which are what light the app's ring) to
// one document at a time — on the page of frames only the frame last clicked
// would ever react to the remote. So when this document does not hold real
// focus, the same events are dispatched by hand; React hears them as onFocus /
// onBlur just the same.
let cur = null;
const synth = el => {
  const old = cur && cur.isConnected ? cur : null;
  if (old === el) return;
  if (old) old.dispatchEvent(new FocusEvent('focusout', {bubbles: true, relatedTarget: el}));
  cur = el;
  el.dispatchEvent(new FocusEvent('focusin', {bubbles: true, relatedTarget: old}));
};
const current = () => {
  if (cur && cur.isConnected && visible(cur)) return cur;
  const a = document.activeElement;
  return a && a !== document.body && visible(a) ? a : null;
};

const focusEl = el => {
  if (!el) return;
  if (document.hasFocus()) {
    el.focus({preventScroll: true});
    if (document.activeElement !== el) synth(el);
  } else synth(el);
  reveal(el);
};

const move = dir => {
  const from = current();
  if (!from) {
    const all = focusables();
    focusEl(all.find(el => el.dataset.tvpref === '1') || all[0]);
    return;
  }
  focusEl(pick(from, dir));
};

const press = type => {
  window.__tvLastKey = type;
  if (type === 'back') return goBack();
  emit(type);
  if (type === 'left' || type === 'right' || type === 'up' || type === 'down') move(type);
  else if (type === 'select') {
    const el = current();
    if (el && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) el.click();
    // a text box is "pressed" by putting the caret in it
    else if (el) el.focus({preventScroll: true});
  }
};

const KEYS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'select',
  ' ': 'select',
  Escape: 'back',
  Backspace: 'back',
  m: 'menu',
  p: 'playPause',
  MediaPlayPause: 'playPause',
  f: 'fastForward',
  r: 'rewind',
};

if (typeof window !== 'undefined' && !window.__tvRemote) {
  window.__tvRemote = press;
  window.addEventListener(
    'keydown',
    e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const type = KEYS[e.key];
      if (!type) return;
      const typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
      // in a text box the keyboard types; only Up/Down/Escape leave it
      if (typing && !['up', 'down'].includes(type) && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      press(type);
      // the page of frames mirrors a key to its other sizes
      if (window.parent !== window) window.parent.postMessage({tvKeyFrom: type}, '*');
    },
    true,
  );
  // Enter/Space keyup would otherwise press the element a second time
  window.addEventListener(
    'keyup',
    e => {
      if ((e.key === 'Enter' || e.key === ' ') && !/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener('message', e => {
    if (e.data && typeof e.data.tvKey === 'string') press(e.data.tvKey);
  });
  // remember where focus was inside each guide, for autoFocus
  window.addEventListener('focusin', e => {
    cur = e.target;
    for (const g of guidesOf(e.target)) g.__tvLast = e.target;
  });
  // The frame lost the browser's focus (another size was clicked): the TV
  // would still be showing its ring, so put it back by hand.
  window.addEventListener('focusout', e => {
    const t = e.target;
    if (!e.isTrusted) return;
    setTimeout(() => {
      if (document.hasFocus() || !t.isConnected || cur !== t) return;
      cur = null;
      synth(t);
    }, 0);
  });
}

// ---------- components ----------
const TV_ONLY = [
  'hasTVPreferredFocus',
  'isTVSelectable',
  'tvParallaxProperties',
  'nextFocusUp',
  'nextFocusDown',
  'nextFocusLeft',
  'nextFocusRight',
  'nextFocusForward',
  'focusable',
];

const withTvRef = (ref, extra) => node => {
  if (node && !node.requestTVFocus) node.requestTVFocus = () => focusEl(node);
  if (extra) extra(node);
  if (typeof ref === 'function') ref(node);
  else if (ref) ref.current = node;
};

export const Pressable = React.forwardRef(function TvPressable(props, ref) {
  const rest = {...props};
  for (const k of TV_ONLY) delete rest[k];
  const node = React.useRef(null);
  const want = !!props.hasTVPreferredFocus;
  React.useEffect(() => {
    if (!want) return;
    // a frame later, so a screen mounting several claims settles on the last
    const t = setTimeout(() => node.current && visible(node.current) && focusEl(node.current), 30);
    return () => clearTimeout(t);
  }, [want]);
  const off = props.focusable === false || props.isTVSelectable === false || props.disabled;
  const setRef = React.useMemo(() => withTvRef(ref, n => (node.current = n)), [ref]);
  return <RNW.Pressable ref={setRef} {...rest} tabIndex={off ? -1 : 0} dataSet={{...(props.dataSet || {}), tvpref: want ? '1' : '0'}} />;
});

const tvView = Base =>
  React.forwardRef(function TvView(props, ref) {
    const rest = {...props};
    for (const k of TV_ONLY) delete rest[k];
    const setRef = React.useMemo(() => withTvRef(ref), [ref]);
    return <Base ref={setRef} {...rest} />;
  });
export const View = tvView(RNW.View);

export const TVFocusGuideView = React.forwardRef(function TVFocusGuideView(
  {autoFocus, trapFocusUp, trapFocusDown, trapFocusLeft, trapFocusRight, destinations, enabled, safePadding, ...rest},
  ref,
) {
  const setRef = React.useMemo(() => withTvRef(ref), [ref]);
  return (
    <RNW.View
      ref={setRef}
      {...rest}
      dataSet={{
        tvguide: '1',
        autofocus: autoFocus ? '1' : '0',
        trapup: trapFocusUp ? '1' : '0',
        trapdown: trapFocusDown ? '1' : '0',
        trapleft: trapFocusLeft ? '1' : '0',
        trapright: trapFocusRight ? '1' : '0',
      }}
    />
  );
});

// ---------- the device ----------
export const Platform = {
  ...RNW.Platform,
  isTV: true,
  isTVOS: false,
  // an Android 14 box: new enough that perfTier keeps trailers and motion on
  Version: 34,
  constants: {Model: 'Sandbox (browser)', Release: '14', Brand: 'sandbox'},
};

// No native half here: the updater reads as "this build cannot update itself"
// and the app takes its ordinary, promptless path.
export const NativeModules = {...(RNW.NativeModules || {})};

export const StatusBar = Object.assign(() => null, {setHidden() {}, setBarStyle() {}, setBackgroundColor() {}, setTranslucent() {}});
