// Which tab the phone app's bottom bar is on (Home · Movies · Shows · My List
// · Search — the website's phone tab bar). The tab screens live side by side
// inside the stack's first screen (screens/Tabs.tsx) and keep their place
// while another tab is shown; a tap on the tab that is already showing says
// so (`onReselect`), and that tab scrolls back to its top.
import {useEffect, useState} from 'react';
import {registerProfileCache} from '../profileScope';

export type Tab = 'home' | 'movies' | 'shows' | 'list' | 'search';
export const TABS: Tab[] = ['home', 'movies', 'shows', 'list', 'search'];

let current: Tab = 'home';
const subs = new Set<(t: Tab) => void>();
const reselect = new Set<(t: Tab) => void>();

export const getTab = () => current;
export const setTab = (t: Tab) => {
  if (t === current) {
    for (const fn of [...reselect]) fn(t);
    return;
  }
  current = t;
  for (const fn of [...subs]) fn(t);
};
export const resetTabs = () => {
  current = 'home';
  for (const fn of [...subs]) fn(current);
};
export const onReselect = (fn: (t: Tab) => void) => {
  reselect.add(fn);
  return () => {
    reselect.delete(fn);
  };
};
export const useTab = () => {
  const [t, setT] = useState(current);
  useEffect(() => {
    subs.add(setT);
    setT(current);
    return () => {
      subs.delete(setT);
    };
  }, []);
  return t;
};

// the next profile starts on Home
registerProfileCache('phone/tabs', () => {
  current = 'home';
});
