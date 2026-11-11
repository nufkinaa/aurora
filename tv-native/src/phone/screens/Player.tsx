// The phone's player IS the TV's (playback/Player.tsx): the same sources,
// offsets, subtitles drawn in JS, skip intro / recap / credits, Up next, the
// recovery rule and the watch party — with the phone's touch controls drawn
// over it (phone/player/PhoneChrome.tsx, PhoneGestures.tsx) instead of the
// D-pad chrome.
//
// [offline-phone] With the server out of reach (the socket is down), Play does what the
// website's restPlay does: the copy on this device plays (the offline player), and with none —
// and no line at all — one calm toast, "This one isn't on this device — it plays when the
// connection is back", and the person stays where they were.
import React, {useEffect, useState} from 'react';
import {NativeModules, View} from 'react-native';
import {RouteProp, useRoute} from '@react-navigation/native';
import TvPlayer from '../../playback/Player';
import {isOpen} from '../../realtime';
import {showToast} from '../../toast';
import {replacePhone, usePNav} from '../nav';
import {offlineFor} from '../offline/store';

const N = (NativeModules as {AuroraOffline?: {network(): Promise<string>}}).AuroraOffline;

export default function Player(props: React.ComponentProps<typeof TvPlayer>) {
  const route = useRoute<RouteProp<{Player: {id: string; stream?: unknown}}, 'Player'>>();
  const navigation = usePNav();
  const id = route.params?.id;
  const here = id && !route.params?.stream ? offlineFor(id) : null;
  const away = !isOpen();
  const [go, setGo] = useState(!away);
  useEffect(() => {
    if (!away) return;
    if (here && here.state === 'done') {
      replacePhone('OfflinePlayer', {id: here.id});
      return;
    }
    let live = true;
    (N ? N.network() : Promise.resolve('other'))
      .catch(() => 'other')
      .then(net => {
        if (!live) return;
        if (net === 'none') {
          showToast("This one isn't on this device — it plays when the connection is back", '📡');
          if (navigation.canGoBack()) navigation.goBack();
        } else setGo(true); // a line is there: the player tries (and says so itself)
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!go) return <View style={{flex: 1, backgroundColor: '#000'}} />;
  return <TvPlayer {...props} />;
}
