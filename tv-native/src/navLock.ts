// Guards against phantom/duplicate navigations from a laggy remote. Two layers:
//
// 1. canNavigate(navigation): the screen must still be FOCUSED. Once a push
//    lands, the old screen fails this check, so a late/queued OK press that
//    fires on it (remote lag, key delivered twice) can never stack a duplicate
//    screen — that was the "Back goes back into the page I just left" bug.
// 2. A short global time gate for double-presses landing on the SAME still-
//    focused screen within one JS flush (where isFocused() is still true).
//    Kept short: a long window eats fast *intentional* presses and reads as lag.
let lastNav = 0;

export const navReady = (): boolean => {
  const now = Date.now();
  if (now - lastNav < 350) return false;
  lastNav = now;
  return true;
};

type FocusAware = {isFocused: () => boolean};

export const canNavigate = (navigation: FocusAware): boolean =>
  navigation.isFocused() && navReady();
