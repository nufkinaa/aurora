// Two small sheets, the TV's and the website's, on the phone:
//   Join a watch party   the code from another screen → the party's film, in step
//   Report a problem     a few words; where you are, what is playing and the last
//                        errors this phone saw come along by themselves
import React, {useState} from 'react';
import {Platform, StyleSheet, Text, View} from 'react-native';
import {api} from '../../api';
import {resolvePartyRoute} from '../../party';
import {track} from '../../usage';
import {showToast} from '../../toast';
import {playingContext, recentErrors} from '../../errors';
import {currentRouteName, pushScreen, rootNav} from '../../rootNav';
import {isOpen as socketOpen} from '../../realtime';
import Sheet from '../ui/Sheet';
import Field from '../ui/Field';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {GUTTER} from '../theme';

import {PHONE_APP_VERSION as PHONE_VERSION} from '../../update';

export function JoinPartySheet({onClose}: {onClose: () => void}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const join = async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4 || busy) return;
    setBusy(true);
    setErr('');
    const route = await resolvePartyRoute(c);
    if (!route) {
      setErr('No party with that code. Codes are four letters and expire when the host leaves.');
      setBusy(false);
      return;
    }
    track('feat', {f: 'party_join'});
    onClose();
    pushScreen('Player', {...route, party: c});
  };
  return (
    <Sheet visible onClose={onClose} title="Join a watch party" sub="Type the code another screen shows, and watch in step with it.">
      <View style={s.pad}>
        <Field value={code} onChangeText={t => setCode(t.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8))} autoFocus autoCapitalize="characters" autoCorrect={false} placeholder="ABCD" returnKeyType="go" onSubmitEditing={join} style={s.code} />
        {err ? <Text style={s.err}>{err}</Text> : null}
        <View style={s.row}>
          <PrimaryButton uiId="party.join" label="Join" icon="people" onPress={join} busy={busy} disabled={code.trim().length < 4} style={{flex: 1}} />
          <GlassButton label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}

export function ReportSheet({hint, onClose}: {hint?: string; onClose: () => void}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr('');
    const playing = playingContext();
    const c = Platform.constants as {Model?: string; Release?: string};
    try {
      await api.report(
        `${text.trim()}${hint ? `\n\n(${hint})` : ''}`,
        {
          route: `phone:${currentRouteName()}`,
          title: playing ? playing.title : null,
          itemId: playing ? playing.id : null,
          look: 'phone',
          ua: `Aurora for Android ${PHONE_VERSION} · Android ${c.Release || ''} · ${c.Model || 'phone'}`,
          viewport: 'phone',
          online: socketOpen(),
          version: PHONE_VERSION,
          errors: recentErrors(),
          startup: playing && playing.startup ? playing.startup() : null,
        },
        rootNav().profileName,
      );
      track('feat', {f: 'report'});
      onClose();
      showToast('Sent — thank you. It landed with the admin.', '🛠️');
    } catch (e) {
      setErr((e as Error).message || "Couldn't send it — try again in a moment");
      setBusy(false);
    }
  };
  return (
    <Sheet visible onClose={onClose} title="Report a problem" sub="A few words is enough. Where you are, what is playing and the last errors this phone saw come along by themselves.">
      <View style={s.pad}>
        <Field value={text} onChangeText={setText} autoFocus multiline placeholder="What went wrong? What did you expect?" style={s.text} />
        {err ? <Text style={s.err}>{err}</Text> : null}
        <View style={s.row}>
          <PrimaryButton uiId="report.send" label="Send report" icon="send" onPress={send} busy={busy} disabled={!text.trim()} style={{flex: 1}} />
          <GlassButton label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  pad: {paddingHorizontal: GUTTER, paddingTop: 4},
  code: {fontSize: 26, fontWeight: '800', letterSpacing: 6, textAlign: 'center', height: 64},
  text: {height: 120, textAlignVertical: 'top', paddingTop: 14},
  err: {color: '#ffb3b3', fontSize: 14, marginTop: 10},
  row: {flexDirection: 'row', gap: 10, marginTop: 16},
});
