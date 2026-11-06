// [play-on-tv] "Play on TV" in the phone's player (PhoneChrome's top bar):
// there only while a TV is on. It hands the TV what this player plays — the
// title, this second, these subtitles and this audio (the player's own remote
// state, remote/player.ts) — and once the TV has it, this player pauses and
// the remote for that TV comes up.
import React from 'react';
import {activePlayer} from '../../remote/player';
import {PLAY_ON} from '../../remote/playOnWords';
import {useDevices} from './controller';
import {fromNow, sendToTv} from './playOnTv';

export default function PlayOnTvSlot({children}: {children: (onPress: () => void, label: string) => React.ReactNode}) {
  const tvs = useDevices().filter(d => d.caps?.playItem !== false);
  if (!tvs.length) return null;
  const onPress = () => {
    const p = activePlayer();
    const n = p?.now();
    if (!p || !n) return;
    const f = fromNow(n);
    sendToTv(tvs, f.item, {position: p.position(), subLang: f.subLang, audioLang: f.audioLang, after: () => p.pause()});
  };
  return <>{children(onPress, tvs.length === 1 ? PLAY_ON.buttonFor(tvs[0].name) : PLAY_ON.button)}</>;
}
