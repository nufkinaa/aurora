// What a signed-in session switches on, in one place: the socket (with who we
// are), usage stats, prefetch, the overlays' idea of the profile, and the
// app-wide toasts for things the server says while browsing.
import {useEffect} from 'react';
import {useApp} from './AppContext';
import {MyDownload} from './api';
import {useMe} from './navSection';
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
    loadPrefs().then(p => setUsageEnabled(p.usageStats !== false));
    track('app', {v: 'open'});
    connect();
    return () => {
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
    const a = onMessage('admin_message', d => d.message && showToast(String(d.message), '📢'));
    const b = onMessage('server_notice', d => d.message && showToast(String(d.message), '🛠️'));
    const c = onMessage('download_update', d => {
      const job = d.job as MyDownload | undefined;
      if (job && job.mine && job.status === 'done' && job.libraryId && !job.seenAt) {
        showToast(`“${job.label || job.title}” is ready to play — Settings → My downloads`, '✅');
      }
    });
    return () => {
      a();
      b();
      c();
    };
  }, []);
  return null;
}
