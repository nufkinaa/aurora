// What a signed-in session switches on, in one place: the socket (with who we
// are), usage stats, prefetch, the overlays' idea of the profile, and the
// app-wide toasts for things the server says while browsing.
import {useEffect} from 'react';
import {AppState} from 'react-native';
import {useApp} from './AppContext';
import {MyDownload} from './api';
import {askNotificationPermission, onDownloadLanded, setDownloadNotices} from './homeScreen';
import {patchMe, useMe} from './navSection';
import {enterPerson, leavePerson, onPersonPrefs, refreshPerson, setProfileReadSink} from './personSync';
import {setPrefetchProfile, stopPrefetch} from './prefetch';
import {connect, disconnect, onMessage, setIdentity} from './realtime';
import {setRootIdentity} from './rootNav';
import {loadPrefs} from './storage';
import {showToast} from './toast';
import {setUsageEnabled, setUsageProfile, track} from './usage';

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
    // device — nothing is counted until the box's own copy has been read
    // (loadPrefs waits for it), so a person who said no is never reported
    // for the first seconds of a session.
    setUsageEnabled(false);
    setProfileReadSink((id, prefs) => patchMe(id, {prefs: prefs as never}));
    enterPerson(profileId);
    const offPerson = onPersonPrefs(p => setUsageEnabled(p.usageStats !== false));
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
    return () => {
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

  useEffect(() => {
    if (!me) return;
    setRootIdentity(profileId, me.name);
    setIdentity({id: profileId, name: me.name, avatar: me.avatar, avatarImage: me.avatarImage || null});
  }, [me, profileId]);

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
      if (!job || job.status !== 'done') return;
      if (job.mine && job.libraryId && !job.seenAt) {
        showToast(`“${job.label || job.title}” is ready to play — Settings → My downloads`, '✅');
      }
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
