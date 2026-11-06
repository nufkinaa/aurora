// The More sheet (the tab bar's "More"): every place without a tab, one line
// each, in the order and words of docs/android-phone/NAV.md — a bottom sheet
// that scrolls when the phone's font is large, Back or a tap outside closes it.
import React from 'react';
import {StyleSheet, View, useWindowDimensions} from 'react-native';
import Sheet from '../ui/Sheet';
import ListRow from '../ui/Row';
import {closeMore, runMore, useMoreShown} from '../moreMenu';
import {moreEntries} from '../moreItems';
import {useAiEnabled} from '../aiStatus';

export default function MoreSheet() {
  const shown = useMoreShown();
  const ai = useAiEnabled();
  const all = moreEntries({ai});
  // with the phone's font turned well up, the places alone (the second lines made it a long scroll)
  const big = (useWindowDimensions().fontScale || 1) > 1.3;
  const row = (e: (typeof all)[number]) => (
    <ListRow
      key={e.key}
      uiId={e.uiId}
      icon={e.icon}
      title={e.label}
      titleLines={4}
      detail={big ? undefined : e.detail}
      chevron={e.group === 'places'}
      onPress={() => {
        closeMore();
        // after the sheet has gone: a line that opens a sheet of its own must find none up
        setTimeout(() => runMore(e.key), 0);
      }}
    />
  );
  return (
    <Sheet visible={shown} onClose={closeMore} title="More">
      {all.filter(e => e.group === 'places').map(row)}
      <View style={s.rule} />
      {all.filter(e => e.group === 'actions').map(row)}
    </Sheet>
  );
}

const s = StyleSheet.create({
  rule: {height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)', marginHorizontal: 20, marginVertical: 6},
});
