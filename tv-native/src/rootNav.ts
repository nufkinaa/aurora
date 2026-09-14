// The navigator's root handle, for code that lives outside any screen (the
// overlays, the party client). Kept apart from navigation.tsx so importing it
// never pulls the screens in — Card imports overlay.ts, which imports this.
import {createNavigationContainerRef, StackActions} from '@react-navigation/native';
import type {RootStackParamList} from './navigation';
import {navReady} from './navLock';

export const navRef = createNavigationContainerRef<RootStackParamList>();

// Who is signed in, for overlays (they render above the AppContext provider).
const who: {profileId: string | null; profileName: string | null} = {profileId: null, profileName: null};
export const setRootIdentity = (profileId: string | null, profileName: string | null) => {
  who.profileId = profileId;
  who.profileName = profileName;
};

export const pushScreen = <R extends keyof RootStackParamList>(name: R, params: RootStackParamList[R]) => {
  if (!navRef.isReady() || !navReady()) return;
  navRef.dispatch(StackActions.push(name as string, params as object));
};

// A navigation-shaped object for openItem() from outside a screen.
export const rootNav = () => ({
  profileId: who.profileId,
  profileName: who.profileName,
  nav: {
    isFocused: () => navRef.isReady(),
    push: (name: string, params: object) => navRef.isReady() && navRef.dispatch(StackActions.push(name, params)),
  } as never,
});

export const currentRouteName = () => (navRef.isReady() ? navRef.getCurrentRoute()?.name || '' : '');
