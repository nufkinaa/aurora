// THE PROFILE WALL'S RULES, shared by the TV's wall (screens/ProfileGate.tsx)
// and the phone's (phone/screens/Gate.tsx): which profiles, in which order,
// what a press on a tile does (straight in, the password, the household PIN,
// leaving a kids profile), and what each answer from the server means. Moved
// out of ProfileGate.tsx as it was (docs/android-phone/PLAN.md); the comments
// below are the TV's and hold for both.
//
// KIDS PROFILES (2026-10-08). A kids profile wears a "Kids" badge. Entering
// one writes a lock on this TV (storage.ts KidsLock); while that lock stands,
// opening any OTHER profile first asks for the household PIN, which the
// server checks (POST /api/kids/exit). Going back into the same kids profile
// — or into a stricter one — asks nothing. Separately, the server itself asks
// for the PIN before it opens a grown-up's profile that has no password
// (401 {pinRequired:true} from unlock); the same PIN view answers that.
import {useEffect, useMemo, useRef, useState} from 'react';
import {api, getSession, setSession, ApiError, Profile} from './api';
import {
  clearKidsLock,
  KidsLock,
  loadKidsLock,
  loadRecentProfiles,
  pushRecentProfile,
  saveAuthSession,
  saveKidsLock,
} from './storage';
import {profilePicked} from './telemetry'; // [analytics]

export type OnChosen = (profileId: string, token: string | null, sid?: string | null, extra?: {mustReset?: boolean; typed?: string | null}) => void;

export function useProfileWall(onChosen: OnChosen) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [pwFor, setPwFor] = useState<Profile | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped by the failure state's Retry.
  const [attempt, setAttempt] = useState(0);
  // The kids profile this TV is in (or was last left in): see the header.
  const [lock, setLock] = useState<KidsLock | null>(null);
  // The PIN view: who it is for, and why. 'exit' = leaving the kids profile
  // (checked by /api/kids/exit); 'open' = the server asked for the PIN to
  // open a profile that has no password (checked by unlock itself).
  const [pinFor, setPinFor] = useState<{profile: Profile; mode: 'exit' | 'open'} | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  // The PIN the server last accepted in this visit to the wall — so leaving a
  // kids profile for a password-free one asks once, not twice.
  const goodPin = useRef('');

  useEffect(() => {
    let live = true;
    // Deliberately NOT clearing loadError here: doing so unmounts the Retry
    // button for the whole in-flight window, and with nothing else focusable
    // during a retry that is a dead remote on the one screen with no way back.
    // The error (and its button) clear on success instead.
    Promise.all([api.profiles(), loadRecentProfiles(), loadKidsLock()])
      .then(([list, rec, kl]) => {
        if (!live) return;
        setProfiles(list);
        setRecent(rec);
        setLoadError('');
        // A lock only means something while its profile is still a kids one
        // (the admin switched kids mode off, or deleted it: nothing to guard).
        const still = kl ? list.find(p => p.id === kl.id) : null;
        if (kl && still && still.kids) {
          console.log('[kids] wall: this TV is locked to kids profile', kl.id, 'limit', still.kids.maxAge);
          setLock({id: kl.id, maxAge: still.kids.maxAge});
        } else {
          if (kl) {
            console.log('[kids] wall: stored lock', kl.id, 'is void (no longer a kids profile)');
            clearKidsLock();
          }
          setLock(null);
        }
      })
      .catch(() => live && setLoadError('Could not load profiles from the server.'));
    return () => {
      live = false;
    };
  }, [attempt]);

  // This TV's own profiles first (most recent first), everything else by name.
  const ordered = useMemo(() => {
    const list = profiles || [];
    const rank = new Map(recent.map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id)! : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id)! : Infinity;
      if (ra !== rb) return ra - rb;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [profiles, recent]);


  const choose = async (p: Profile, pw = '', withPin = goodPin.current) => {
    // A second OK while the unlock is in flight would double-POST and call
    // onChosen twice.
    if (busy) return;
    setBusy(true);
    setPwError('');
    setPinError('');
    try {
      const res = await api.unlock(p.id, pw, withPin || undefined);
      if (res.token) {
        profilePicked(); // [analytics] profile accepted → Home usable, as a timing
        // Remember it for this TV before handing control up, so the next visit
        // to the gate lands straight on the profile actually used here.
        await pushRecentProfile(p.id);
        // Into a kids profile: this TV is locked to it from here on. Into
        // anyone else's: whatever lock there was has been answered for.
        if (p.kids) {
          console.log('[kids] entered kids profile', p.id, 'limit', p.kids.maxAge, '- TV locked to it');
          await saveKidsLock({id: p.id, maxAge: p.kids.maxAge});
        } else {
          if (lock) console.log('[kids] left kids profile', lock.id, 'for', p.id, '- lock cleared');
          await clearKidsLock();
        }
        // A claimed profile's unlock signs the device in on the spot — carry
        // the session up so the eventual flip to closed mode costs nothing.
        onChosen(p.id, res.token, res.session || null, res.mustReset ? {mustReset: true, typed: pw} : undefined);
      } else {
        setPwError(res.error === 'wrong password' ? 'Wrong password' : 'Could not unlock');
      }
    } catch (e) {
      // The household PIN is wanted (a profile with no password, in a house
      // with a kids profile) — or the one just sent was wrong / rate-limited.
      // The message is the server's own either way.
      if (e instanceof ApiError && (e.pinRequired || (e.status === 429 && pinFor))) {
        console.log('[kids] unlock of', p.id, 'wants the household PIN:', e.status, e.message);
        goodPin.current = '';
        setPwFor(null);
        setPin('');
        // (no PIN was sent: that is a question, not an error to show in red)
        setPinError(withPin || e.status === 429 ? e.message : '');
        setPinFor({profile: p, mode: 'open'});
      }
      // The server returns 401 for a wrong password and 403 for an admin-locked
      // profile — distinguish those from an actual network failure.
      // (A profile with no password has no password view to print into: its
      // failures used to vanish. They go to the wall's own error line.)
      else {
        const show = pw || pwFor ? setPwError : setLoadError;
        if (e instanceof ApiError && e.status === 429) show(e.message);
        else if (e instanceof ApiError && e.status === 401) show('Wrong password');
        else if (e instanceof ApiError && e.status === 403) {
          show('This profile has been locked by an admin');
        } else show('Could not reach the server');
      }
    } finally {
      setBusy(false);
    }
  };

  // The PIN has let this TV out of the kids profile. If the TV is also SIGNED
  // IN as that profile (its unlock minted a session, which rides every
  // request as X-Session), the server would go on reading every request as
  // the child's — the grown-up's profile, opened next, would come up
  // filtered. The site is told by a cookie; here the session is simply ended.
  const dropKidsSession = async (kidId: string) => {
    if (!getSession()) return;
    try {
      const who = await api.me();
      if (who.user && who.user.profileId === kidId) {
        console.log('[kids] this TV was signed in as the kids profile - ending that session');
        await api.logout().catch(() => {});
        setSession(null);
        await saveAuthSession(null);
      }
    } catch {}
  };

  // Past the kids lock (or there was none): the profile's own door.
  //
  // YOUR OWN PROFILE, ON A TV THAT IS SIGNED IN AS YOU, asks for no password:
  // the session this TV holds was made by that very password (the website
  // does the same at its picker). The server decides — /api/me says whose
  // session it is and /api/auth/profile-token turns it into an unlock token;
  // anything short of that (no session, someone else's, a refusal, no
  // answer) falls through to the password, as before.
  const open = async (p: Profile) => {
    if (p.hasPassword && getSession() && !busy) {
      setBusy(true);
      try {
        const who = await api.me();
        // This TV's session is that profile's and a new password is owed
        // (server: /api/me says so instead of naming the user): straight to
        // the new-password screen, which saves with the session it holds.
        if (who.passwordResetRequired && who.resetProfile?.id === p.id) {
          onChosen(p.id, null, null, {mustReset: true, typed: null});
          return;
        }
        if (who.user && who.user.profileId === p.id) {
          const t = await api.profileTokenFromSession();
          if (t.token && t.profileId === p.id) {
            await pushRecentProfile(p.id);
            if (p.kids) await saveKidsLock({id: p.id, maxAge: p.kids.maxAge});
            else await clearKidsLock();
            onChosen(p.id, t.token, null, who.user.mustReset || who.mustReset ? {mustReset: true, typed: null} : undefined);
            return;
          }
        }
      } catch {
        // the password it is
      } finally {
        setBusy(false);
      }
    }
    if (p.hasPassword) {
      setPinFor(null);
      setPwFor(p);
      setPassword('');
      setPwError('');
    } else {
      choose(p);
    }
  };

  // Does picking `p` mean LEAVING the kids profile this TV is locked to?
  // Not when it is that profile, nor a kids profile at least as strict.
  const leavesKids = (p: Profile) =>
    !!lock && p.id !== lock.id && !(p.kids && p.kids.maxAge <= lock.maxAge);

  const onTile = async (p: Profile) => {
    if (p.locked) {
      setLoadError(`"${p.name}" has been locked by an admin.`);
      return;
    }
    setLoadError('');
    if (!leavesKids(p)) return open(p);
    if (busy) return;
    // Leaving a kids profile. Is there a PIN in the house at all?
    setBusy(true);
    let pinSet = true; // can't tell (server unreachable): ask — never fail open
    try {
      pinSet = !!(await api.kidsStatus()).pinSet;
    } catch (e) {
      // a server from before kids profiles has no such route and nothing to guard
      if (e instanceof ApiError && e.status === 404) pinSet = false;
    }
    setBusy(false);
    if (!pinSet) {
      console.log('[kids] leaving', lock?.id, '- no household PIN is set, nothing to ask');
      if (lock) await dropKidsSession(lock.id);
      await clearKidsLock();
      setLock(null);
      return open(p);
    }
    console.log('[kids] leaving', lock?.id, 'for', p.id, '- asking for the household PIN');
    setPin('');
    setPinError('');
    setPinFor({profile: p, mode: 'exit'});
  };

  // OK on the PIN view.
  const submitPin = async () => {
    if (!pinFor || busy) return;
    const typed = pin.trim();
    if (!/^\d{4,6}$/.test(typed)) {
      setPinError('The PIN is 4 to 6 digits.');
      return;
    }
    const target = pinFor.profile;
    if (pinFor.mode === 'open') {
      // the unlock itself checks it (and comes back here if it was wrong)
      return choose(target, '', typed);
    }
    setBusy(true);
    setPinError('');
    try {
      await api.kidsExit(typed, lock ? lock.id : '');
      console.log('[kids] PIN accepted - lock on', lock?.id, 'lifted');
      goodPin.current = typed;
      if (lock) await dropKidsSession(lock.id);
      await clearKidsLock();
      setLock(null);
      setPinFor(null);
      setPin('');
      setBusy(false);
      // `choose` reads goodPin, so a password-free profile opens on this PIN
      if (target.hasPassword) open(target);
      else choose(target, '', typed);
      return;
    } catch (e) {
      // 401 "That's not the PIN." / 429 "too many attempts — try again in a
      // few minutes": the server's words, as they are.
      const msg = e instanceof ApiError && e.status ? e.message : 'Could not reach the server';
      console.log('[kids] PIN refused:', e instanceof ApiError ? e.status : 0, msg);
      setPinError(msg);
      setPin('');
    }
    setBusy(false);
  };
  return {
    profiles,
    ordered,
    loadError,
    setLoadError,
    pwFor,
    setPwFor,
    password,
    setPassword,
    pwError,
    setPwError,
    busy,
    lock,
    pinFor,
    setPinFor,
    pin,
    setPin,
    pinError,
    setPinError,
    choose,
    open,
    onTile,
    submitPin,
    retry: () => setAttempt(n => n + 1),
  };
}
