// Links into the phone app (what they open: linkParse.ts): the one it was
// started with, and any that arrive while it is open — a notification, a
// nufurora.com address from a chat, the share sheet's link from another phone,
// a TV's sign-in QR scanned with the camera (nufurora.com/link?code=…).
//
// A link can arrive before there is anywhere to open it: on the "Who's
// watching?" wall, the sign-in page, or while the app is still finding its
// server. It is HELD (pendingLink) from the moment this module loads, and
// opened once a profile is in and the screens are up (useLinks) — so scanning
// a TV's QR with the app closed still lands on "Sign in this TV?".
import {useEffect} from 'react';
import {Linking} from 'react-native';
import {StackActions} from '@react-navigation/native';
import {navRef} from '../rootNav';
import {getBaseUrl} from '../api';
import {resolvePartyRoute} from '../party';
import {showToast} from '../toast';
import {isAuthLink, parsePhoneLink, PhoneLink} from './linkParse';
import {setTab} from './tabs';

/** The hosts whose web addresses the app answers: nufurora.com, and the server this phone is on. */
export const linkHosts = (): string[] => {
  const out = ['nufurora.com'];
  const m = /^https?:\/\/([^/?#]+)/i.exec(getBaseUrl() || '');
  if (m && !out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase());
  return out;
};

const push = (name: string, params?: object) => {
  if (!navRef.isReady()) return;
  navRef.dispatch(StackActions.push(name, params));
};

export async function openLink(l: PhoneLink) {
  if (!navRef.isReady()) return;
  switch (l.kind) {
    case 'item': {
      const it = l.item;
      const libraryFilm = it.type === 'movie' && it.source !== 'stream' && !String(it.id).startsWith('torrent|');
      const libraryEpisode = !it.type && (it as {season?: number}).season != null;
      if (l.action === 'play' && (libraryFilm || libraryEpisode)) push('Player', {id: it.id, title: it.title});
      else push('Detail', {item: it});
      return;
    }
    case 'party': {
      const r = await resolvePartyRoute(l.code);
      if (!r) return showToast('That watch party has ended', '👥');
      push('Player', {...r, party: l.code});
      return;
    }
    case 'pair':
      // a second scan of the same QR while its page is up: that page, not another on top
      if ((navRef.getCurrentRoute()?.name as string | undefined) === 'PairTv') navRef.dispatch(StackActions.replace('PairTv', {code: l.code}));
      else push('PairTv', {code: l.code});
      return;
    case 'search':
      push('Search', {q: l.q});
      return;
    case 'play':
      push('Player', {id: l.id, title: ''});
      return;
    case 'screen':
      push(l.name, l.params);
      return;
    case 'web':
      // a page only the website has (Pick for me, Requests): the app was
      // opened for it, so say where it is rather than drop the person on Home unexplained
      showToast(`That page is on the website — open ${linkHosts()[0]}/#/${l.path} in the browser`, '🌐');
      return;
    case 'tab':
      if (navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
      setTab(l.tab);
      return;
    case 'googleAuth':
      // (never here: arrived() hands these to the sign-in screens)
      return;
    case 'resetLink':
      // a reset link opened while signed in: the password is changed in Settings here
      showToast("You're signed in on this phone. Change your password in Settings → Edit profile & password.", '🔑', 6000);
      return;
  }
}

// ---- [auth-round] Google's way back (aurora-phone://auth/google?code=…) ----
// It belongs to the sign-in screens (phone/auth), which are up BEFORE a profile
// is: so it is never held for the navigator. A screen that can finish it
// listens (onAuthLink); one that arrives with nobody listening (a cold start:
// the app was closed while the tab was open) waits here until one does.
let authPending: string | null = null;
let authPendingAt = 0;
let authListener: ((url: string) => void) | null = null;
// The same address again within two minutes is the same arrival: Android hands the
// activity's intent over again when the screen is rebuilt (a display size or density
// change, PhoneActivity.onCreate) — a used Google code or reset link must not be tried
// twice and say "already used" over a sign-in that worked.
const authRecent = new Map<string, number>();
const AUTH_REPEAT_MS = 2 * 60 * 1000;
const authArrived = (url: string) => {
  const now = Date.now();
  const seen = authRecent.get(url);
  if (seen && now - seen < AUTH_REPEAT_MS) return;
  authRecent.set(url, now);
  if (authListener) authListener(url);
  else {
    authPending = url;
    authPendingAt = now;
  }
};
/** Is a Google hand-off waiting for a sign-in screen? */
export const pendingAuthLink = () => authPending;
/** The sign-in screens listen while they are up; a waiting hand-off is delivered at once. */
export function onAuthLink(fn: (url: string) => void): () => void {
  authListener = fn;
  // (one held longer than Google's hand-off lives is of no use: the app went on without it)
  const held = authPending && Date.now() - authPendingAt < 10 * 60 * 1000 ? authPending : null;
  authPending = null;
  if (held) setTimeout(() => authListener === fn && fn(held), 0);
  return () => {
    if (authListener === fn) authListener = null;
  };
}

// ---- held until the screens are up ----
let pending: string | null = null;
let mounted = false;
let deliver: ((url: string) => void) | null = null;
let initialAsked = false;
const arrived = (url: string | null | undefined) => {
  if (!url) return;
  // Google's answer, an emailed reset link: the sign-in screens' (held for them when none is
  // up and no profile is open either — a cold start)
  // (with a profile open, Google's answer is dropped — nothing here was waiting for it — and a
  // reset link says where the password is changed)
  if (isAuthLink(parsePhoneLink(url, linkHosts())) && (authListener || !deliver)) return authArrived(url);
  if (deliver) deliver(url);
  else pending = url;
};
// From the first moment: the link that started the app, and any that come
// while the wall or the sign-in page is up. (Guarded: jest has no Linking.)
try {
  Linking.addEventListener('url', e => arrived(e?.url));
} catch {}
const askInitial = () => {
  if (initialAsked) return;
  initialAsked = true;
  Linking.getInitialURL()
    .then(u => {
      if (u && isAuthLink(parsePhoneLink(u, linkHosts())) && !mounted) {
        // (once per run, like every starting link: a profile switch must not finish it again)
        authArrived(u);
        return;
      }
      // the link that started this run — once per run, not again after a profile switch
      if (u && !mounted) pending = pending || u;
      else if (u && deliver) deliver(u);
    })
    .catch(() => {});
};
try {
  askInitial();
} catch {}

/** For the tests and the wall: is a link waiting for a profile? */
export const pendingLink = () => pending;

/** PhoneNavigator mounts this once. */
export function useLinks() {
  useEffect(() => {
    let on = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const open = (url: string) => {
      const l = parsePhoneLink(url, linkHosts());
      if (!l) return;
      // the navigator needs a moment after it mounts (the TV's first-route rule)
      const go = () => {
        if (!on) return;
        if (navRef.isReady()) openLink(l);
        else t = setTimeout(go, 200);
      };
      go();
    };
    mounted = true;
    askInitial();
    const held = pending;
    pending = null;
    if (held) t = setTimeout(() => open(held), 700);
    deliver = url => open(url);
    return () => {
      on = false;
      deliver = null;
      if (t) clearTimeout(t);
    };
  }, []);
}
