// A grid of posters that fills the phone's width: as many columns of at least
// MIN_W as fit (3 on a phone in portrait, 5–6 in landscape, more on a
// tablet), the posters stretched to share the row evenly. Virtualised
// (FlatList), with a header above the first row and paging at the end.
import React, {useCallback} from 'react';
import {FlatList, FlatListProps, StyleSheet, View, useWindowDimensions} from 'react-native';
import {HeroItem} from '../../api';
import {PosterCard} from './Cards';
import {GUTTER} from '../theme';
import {LISTS} from '../lowEnd';

const MIN_W = 104;
const GAP = 10;

export const gridColumns = (width: number) => Math.max(3, Math.floor((width - GUTTER * 2 + GAP) / (MIN_W + GAP)));

type Props = {
  items: HeroItem[];
  onPress: (it: HeroItem) => void;
  onLongPress?: (it: HeroItem) => void;
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  empty?: React.ReactElement | null;
  onEndReached?: () => void;
  bottomPad?: number;
  topPad?: number;
  refreshControl?: FlatListProps<HeroItem>['refreshControl'];
  listRef?: React.Ref<FlatList<HeroItem>>;
  onScroll?: FlatListProps<HeroItem>['onScroll'];
};

export default function Grid({items, onPress, onLongPress, header, footer, empty, onEndReached, bottomPad = 0, topPad = 0, refreshControl, listRef, onScroll}: Props) {
  const {width} = useWindowDimensions();
  const cols = gridColumns(width);
  const cardW = Math.floor((width - GUTTER * 2 - GAP * (cols - 1)) / cols);
  const render = useCallback(
    ({item}: {item: HeroItem}) => <PosterCard item={item} width={cardW} onPress={onPress} onLongPress={onLongPress} />,
    [cardW, onPress, onLongPress],
  );
  return (
    <FlatList
      ref={listRef}
      key={`cols-${cols}`}
      data={items}
      numColumns={cols}
      keyExtractor={(it, i) => `${it.id || it.imdbId || it.title}-${i}`}
      renderItem={render}
      columnWrapperStyle={s.row}
      contentContainerStyle={{paddingBottom: bottomPad, paddingTop: topPad}}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      ItemSeparatorComponent={Sep}
      onEndReached={onEndReached}
      onEndReachedThreshold={1.2}
      initialNumToRender={cols * LISTS.gridRows}
      maxToRenderPerBatch={cols * 2}
      windowSize={LISTS.gridWindow}
      removeClippedSubviews
      refreshControl={refreshControl}
      onScroll={onScroll}
      scrollEventThrottle={64}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    />
  );
}

const Sep = () => <View style={{height: GAP}} />;

const s = StyleSheet.create({
  row: {paddingHorizontal: GUTTER, gap: GAP},
});
