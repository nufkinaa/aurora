// Two small sheets, the TV's and the website's, on the phone:
//   Join a watch party   the code from another screen → the party's film, in step
//   Report a problem     a few words; where you are, what is playing and the last
//                        errors this phone saw come along by themselves
import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {api} from '../../api';
import {resolvePartyRoute} from '../../party';
import {track} from '../../usage';
import {showToast} from '../../toast';
import {reportContext, reportPeek, ReportContext} from '../../clientContext';
import {pushScreen, rootNav} from '../../rootNav';
import Sheet from '../ui/Sheet';
import Field from '../ui/Field';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import Tap from '../ui/Tap';
import {GUTTER} from '../theme';


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
  // [report trail] "See what will be sent": read when asked for, and exactly that goes
  const [peek, setPeek] = useState<ReportContext | null>(null);
  const [peekOpen, setPeekOpen] = useState(false);
  const togglePeek = () => {
    if (!peek) setPeek(reportContext('phone'));
    setPeekOpen(o => !o);
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api.report(`${text.trim()}${hint ? `\n\n(${hint})` : ''}`, peek || reportContext('phone'), rootNav().profileName);
      track('feat', {f: 'report'});
      onClose();
      showToast('Sent — thank you. It landed with the admin.', '🛠️');
    } catch (e) {
      setErr((e as Error).message || "Couldn't send it — try again in a moment");
      setBusy(false);
    }
  };
  return (
    <Sheet visible onClose={onClose} title="Report a problem" sub="A few words is enough. Where you are, what is playing, your last steps in the app and facts about this phone come along by themselves — never anything you typed, except a search you ran.">
      <View style={s.pad}>
        <Field value={text} onChangeText={setText} autoFocus multiline placeholder="What went wrong? What did you expect?" style={s.text} />
        <Tap uiId="report.peek" flat onPress={togglePeek} accessibilityRole="button" style={s.peekTap}>
          <Text style={s.peekToggle}>{peekOpen ? 'Hide what will be sent' : 'See what will be sent'}</Text>
        </Tap>
        {peekOpen && peek ? (
          <ScrollView style={s.peekBox} nestedScrollEnabled>
            <Text style={s.peekText} selectable>{reportPeek(peek)}</Text>
          </ScrollView>
        ) : null}
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
  // [report trail] what comes along, and a look at it
  peekTap: {marginTop: 4, paddingVertical: 10, alignSelf: 'flex-start'},
  peekToggle: {color: 'rgba(255,255,255,0.78)', fontSize: 13.5, fontWeight: '600'},
  peekBox: {maxHeight: 240, marginTop: 4, padding: 10, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)'},
  peekText: {color: 'rgba(255,255,255,0.72)', fontSize: 11.5, lineHeight: 16, fontFamily: 'monospace'},
  row: {flexDirection: 'row', gap: 10, marginTop: 16},
});
