// "Update ready": the phone's own new build (phone/update/store.ts). Update
// fetches it and opens Android's installer, which asks to confirm; Later holds
// that version back for a day. The first time, Android has to allow Aurora to
// install apps — the sheet says so in plain words and opens that switch.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Sheet from '../ui/Sheet';
import { GlassButton, PrimaryButton } from '../ui/Buttons';
import { Bar } from '../ui/Cards';
import { colors, GUTTER } from '../theme';
import { PHONE_APP_VERSION } from '../../update';
import { allowInstalls, later, updateNow, useUpdate } from '../update/store';

export default function UpdateSheet() {
  const u = useUpdate();
  const v = u.info?.version || '';
  const busy = u.phase === 'downloading' || u.phase === 'installing';
  return (
    <Sheet
      visible={u.phase !== 'hidden'}
      onClose={later}
      title="Update ready"
      sub={`Aurora for Android ${v} · this phone has ${PHONE_APP_VERSION}`}
    >
      <View style={s.pad}>
        {u.info?.notes ? <Text style={s.notes}>{u.info.notes}</Text> : null}
        {u.phase === 'permission' ? (
          <Text style={s.body}>
            Android asks once: allow Aurora to install apps, then come back here
            — the update goes on by itself.
          </Text>
        ) : null}
        {busy ? (
          <View style={s.progress}>
            {u.phase === 'downloading' ? (
              <Bar f={Math.max(0.02, u.pct)} bead={false} />
            ) : null}
            <Text style={s.line}>{u.line}</Text>
          </View>
        ) : null}
        {u.phase === 'failed' ? (
          <Text style={s.error}>{`Couldn't update — ${u.error}`}</Text>
        ) : null}
        <View style={s.actions}>
          {u.phase === 'permission' ? (
            <PrimaryButton
              uiId="phone.update.allow"
              label="Allow in Settings"
              icon="gear"
              onPress={allowInstalls}
              style={s.btn}
            />
          ) : (
            <PrimaryButton
              uiId="update.install"
              label={
                u.phase === 'failed'
                  ? 'Try again'
                  : busy
                  ? u.phase === 'installing'
                    ? 'Opening the installer…'
                    : 'Downloading…'
                  : 'Update'
              }
              icon="download"
              busy={busy}
              disabled={busy}
              onPress={updateNow}
              style={s.btn}
            />
          )}
          <GlassButton
            uiId="update.later"
            label={u.phase === 'downloading' ? 'Cancel' : 'Later'}
            onPress={later}
            style={s.btn}
          />
        </View>
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  pad: { paddingHorizontal: GUTTER + 4 },
  notes: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 6,
    marginBottom: 6,
  },
  body: {
    color: colors.textDim,
    fontSize: 15,
    lineHeight: 22,
    marginVertical: 8,
  },
  progress: { marginVertical: 10, gap: 8 },
  line: { color: colors.textDim, fontSize: 14 },
  error: {
    color: colors.danger,
    fontSize: 15,
    lineHeight: 21,
    marginVertical: 8,
  },
  actions: { gap: 10, marginTop: 12 },
  btn: { alignSelf: 'stretch' },
});
