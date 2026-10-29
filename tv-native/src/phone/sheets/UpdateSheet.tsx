// "Update ready": the phone's own new build (phone/update/store.ts has every step). Update
// fetches it and opens Android's installer, which asks to confirm; Later holds that version
// back for a day. The first time, Android has to allow Aurora to install apps — the sheet
// says so in plain words and opens that switch. After the update, the new version says
// what's new here, once.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Sheet from '../ui/Sheet';
import { GlassButton, PrimaryButton } from '../ui/Buttons';
import { Bar } from '../ui/Cards';
import { colors, GUTTER } from '../theme';
import { allowInstalls, dismissUpdated, later, running, updateNow, useUpdate } from '../update/store';

export default function UpdateSheet() {
  const u = useUpdate();
  const v = u.info?.version || '';
  const busy = u.phase === 'downloading' || u.phase === 'verifying' || u.phase === 'installing' || u.phase === 'confirm';
  if (u.phase === 'updated') {
    return (
      <Sheet visible onClose={dismissUpdated} title={`Aurora is updated to ${v}`} sub="What's new on this phone">
        <View style={s.pad}>
          <Text style={s.notes}>{u.info?.notes || 'This phone has the newest Aurora. Your sign-in and what you saved on this phone are all still here.'}</Text>
          <View style={s.actions}>
            <PrimaryButton uiId="phone.update.done" label="Got it" onPress={dismissUpdated} style={s.btn} />
          </View>
        </View>
      </Sheet>
    );
  }
  const primary =
    u.phase === 'failed'
      ? 'Try again'
      : u.phase === 'notInstalled'
      ? 'Install the update'
      : u.phase === 'downloading'
      ? 'Downloading…'
      : u.phase === 'verifying'
      ? 'Checking…'
      : u.phase === 'installing' || u.phase === 'confirm'
      ? 'Waiting for Android…'
      : 'Update';
  return (
    <Sheet visible={u.phase !== 'hidden'} onClose={later} title="Update ready" sub={`Aurora for Android ${v} · this phone has ${running().versionName}`}>
      <View style={s.pad}>
        {u.info?.notes ? <Text style={s.notes}>{u.info.notes}</Text> : null}
        {u.phase === 'permission' ? (
          <Text style={s.body}>Android asks once: allow Aurora to install apps, then come back here — the update goes on by itself.</Text>
        ) : null}
        {busy ? (
          <View style={s.progress}>
            {u.phase === 'downloading' ? <Bar f={Math.max(0.02, u.pct)} bead={false} /> : null}
            <Text style={s.line} accessibilityLiveRegion="polite">
              {u.line}
            </Text>
          </View>
        ) : null}
        {u.error && (u.phase === 'failed' || u.phase === 'notInstalled' || u.phase === 'permission') ? (
          <Text style={u.phase === 'notInstalled' ? s.body : s.error} accessibilityRole="alert">
            {u.phase === 'failed' ? `Couldn't update — ${u.error}` : u.error}
          </Text>
        ) : null}
        <View style={s.actions}>
          {u.phase === 'permission' ? (
            <PrimaryButton uiId="phone.update.allow" label="Allow in Settings" icon="gear" onPress={allowInstalls} style={s.btn} />
          ) : (
            <PrimaryButton uiId="update.install" label={primary} icon="download" busy={busy} disabled={busy} onPress={updateNow} style={s.btn} />
          )}
          <GlassButton uiId="update.later" label={u.phase === 'downloading' || u.phase === 'verifying' ? 'Cancel' : 'Later'} onPress={later} style={s.btn} />
        </View>
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  pad: { paddingHorizontal: GUTTER + 4 },
  notes: { color: colors.text, fontSize: 15, lineHeight: 22, marginTop: 6, marginBottom: 6 },
  body: { color: colors.textDim, fontSize: 15, lineHeight: 22, marginVertical: 8 },
  progress: { marginVertical: 10, gap: 8 },
  line: { color: colors.textDim, fontSize: 14 },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21, marginVertical: 8 },
  actions: { gap: 10, marginTop: 12 },
  btn: { alignSelf: 'stretch' },
});
