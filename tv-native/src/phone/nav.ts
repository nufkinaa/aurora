// The phone screens' navigation handle, typed the way the shared openItem.ts
// takes it (the stack's route names are the TV's — navigation.tsx).
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation';

export type PNav = NativeStackNavigationProp<RootStackParamList, 'Home'>;
export const usePNav = () => useNavigation<PNav>();

/** Push (or swap to) a phone-only screen (Remote, OfflinePlayer) — routes the TV's list does not name. */
import {StackActions} from '@react-navigation/native';
import {navRef} from '../rootNav';
export const pushPhone = (name: 'Remote' | 'OfflinePlayer' | string, params?: object) => {
  if (navRef.isReady()) navRef.dispatch(StackActions.push(name, params));
};
export const replacePhone = (name: string, params?: object) => {
  if (navRef.isReady()) navRef.dispatch(StackActions.replace(name, params));
};
