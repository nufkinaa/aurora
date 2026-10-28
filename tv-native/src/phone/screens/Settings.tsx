// PLACEHOLDER while the phone's Settings screen is built (android-phone branch).
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {BackBar} from '../ui/PageHead';

export default function Settings() {
  return (
    <View style={s.root}>
      <Text style={s.t}>Settings</Text>
      <BackBar />
    </View>
  );
}

const s = StyleSheet.create({root: {flex: 1, alignItems: 'center', justifyContent: 'center'}, t: {color: '#fff', fontSize: 22}});
