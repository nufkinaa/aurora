// What a signed-in session switches on, in one place: the socket (with who we
// are), usage stats, prefetch, the overlays' idea of the profile, and the
// app-wide toasts for things the server says while browsing.
import {useEffect, useRef} from 'react';
import {AppState} from 'react-native';
import {useApp} from './AppContext';
import {MyDownload} from './api';
import {api, getBaseUrl} from './api';
import {reportCaps} from './av'; // what this box can play (TV round 2026-10-19)
import {askNotificationPermission, onDownloadLanded, setDownloadNotices, setPersonReadyNotice} from './homeScreen';
import {patchMe, useMe} from './navSection';
import {enterPerson, leavePerson, onPersonPrefs, personNow, refreshPerson, setProfileReadSink} from './personSync';
import {readyText} from './readyNotice';
import {setPrefetchProfile, stopPrefetch} from './prefetch';
import {connect, disconnect, onMessage, setIdentity} from './realtime';
import {replaceEndedToast} from './replaceLogic';
import {setRootIdentity} from './rootNav';
import {loadPrefs} from './storage';
import {showToast} from './toast';
import {setUsageEnabled, setUsageProfile, track} from './usage';
import {startTarget, stopTarget} from './remote/target'; // [phone-remote]
import {startHouseholdLive} from './householdLive'; // [household]
import {isPhone} from './formFactor'; // [android-phone]

export default function SessionWiring() {
  const {profileId} = useApp();
  const me = useMe(profileId);

  useEffect(() => {
    setUsageProfile(profileId);
    setPrefetchProfile(profileId);
    setRootIdentity(profileId, me?.name || null);
    // SETTINGS THAT FOLLOW THE PERSON (personSync.ts): what the box remembers
    // of this profile applies at once, then the profile itself is asked. Usage
    // stats follow whatever it says, now and when it changes on another
    // device. This is the ONE place the switch comes from (usage.ts THE
    // SWITCH): setUsageProfile above left it "not known yet", so what happens
    // before the box's own copy has been read (loadPrefs waits for it) is
    // held, not sent — a person who said no is never reported for the first
    // seconds of a session, and one who said yes loses nothing of them.
    setProfileReadSink((id, prefs) => patchMe(id, {prefs: prefs as never}));
    enterPerson(profileId);
    const offPerson = onPersonPrefs(p => {
      setUsageEnabled(p.usageStats !== false);
      // "Tell me when it's ready" (the person's): the toast below and this
      // box's notification (homeScreen.ts) both follow it
      setPersonReadyNotice(p.readyNotice !== false);
    });
    // back in front (the TV woke, another app was closed): ask again
    const offActive = AppState.addEventListener('change', s => {
      if (s === 'active') refreshPerson();
    });
    loadPrefs().then(p => {
      setUsageEnabled(p.usageStats !== false);
      track('app', {v: 'open'});
      const notices = p.downloadNotices !== false;
      setDownloadNotices(notices);
      // Android 13+: the one-time ask, on first use of a build that can notify.
      // (Android 12 and earlier: nothing to ask — this only reports.)
      if (notices) askNotificationPermission(false);
    });
    connect();
    // [phone-remote] this TV can be played on / steered from the profile's phones
    // (remote/target.ts: announced on every socket open, so the order with
    // connect() does not matter)
    // (the phone app steers TVs; it is not one to be played on — android-phone)
    if (!isPhone()) startTarget(profileId);
    // [/phone-remote]
    return () => {
      if (!isPhone()) stopTarget(); // [phone-remote] device_leave, while the socket is still open
      offPerson();
      leavePerson();
      offActive.remove();
      disconnect();
      stopPrefetch();
      setUsageProfile(null);
      setPrefetchProfile(null);
      setRootIdentity(null, null);
    };
  }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // WHAT THIS BOX CAN PLAY (TV round 2026-10-19, av.ts): said to the server
  // once per launch (per server), so every title read after it comes back
  // with how it plays HERE — the file as it is when this box decodes it and
  // the TV / soundbar takes its sound. Signed in by now (the report is behind
  // the same wall as the library).
  useEffect(() => {
    reportCaps(api.postCaps, getBaseUrl());
  }, [profileId]);

  useEffect(() => {
    if (!me) return;
    setRootIdentity(profileId, me.name);
    setIdentity({id: profileId, name: me.name, avatar: me.avatar, avatarImage: me.avatarImage || null});
  }, [me, profileId]);

  // [household] someone recommended a title to this profile: a toast and a
  // fresh Home row (householdLive.ts)
  useEffect(() => startHouseholdLive(profileId), [profileId]);

  const saidEnded = useRef(new Set<string>());
  useEffect(() => {
    // this person's settings changed on another device (server: PUT
    // /api/profiles/:id): read the profile again
    const p = onMessage('profile_updated', d => {
      if (String(d.profileId || '') === profileId) refreshPerson();
    });
    const a = onMessage('admin_message', d => d.message && showToast(String(d.message), '📢'));
    const b = onMessage('server_notice', d => d.message && showToast(String(d.message), '🛠️'));
    const c = onMessage('download_update', d => {
      const job = d.job as MyDownload | undefined;
      // Another version that ended without you: said wherever you are (a
      // replacement is not on any screen once its sheet is closed).
      const ended = job ? replaceEndedToast(job) : null;
      // (once: a job's last update can reach this app twice)
      if (job && ended && !saidEnded.current.has(job.id)) {
        saidEnded.current.add(job.id);
        showToast(ended, '↩️');
      }
      if (!job || job.status !== 'done') return;
      // the words are the server's (readyLine / langLine), the same as the
      // website's; the person can switch the notice off (readyNotice.ts)
      const said = readyText(job, personNow()?.readyNotice !== false);
      if (said) showToast(said, '✅');
      // The TV's home-screen row follows ("New: …" in, or out once opened),
      // and a TV notification is posted when it is news (DownloadNotices.kt).
      onDownloadLanded(job);
    });
    return () => {
      p();
      a();
      b();
      c();
    };
  }, [profileId]);
  return null;
}
