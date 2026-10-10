// A screen tells the usage stats its content is on (routeTiming.ts has the
// definition). Called by every screen with its own idea of "ready": the first
// list has arrived, the title's record is in, the first frame has played. A
// screen with nothing to wait for passes `true`.
import {useEffect, useRef} from 'react';
import {useIsFocused, useRoute} from '@react-navigation/native';
import {routeShown} from './routeTiming';

export const useRouteShown = (ready: boolean) => {
  const key = useRoute().key;
  const focused = useIsFocused();
  const first = useRef(true);
  useEffect(() => {
    if (!focused || !ready) return;
    routeShown(key, first.current);
    first.current = false;
  }, [focused, ready, key]);
};
