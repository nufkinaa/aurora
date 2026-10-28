// The phone screens' navigation handle, typed the way the shared openItem.ts
// takes it (the stack's route names are the TV's — navigation.tsx).
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation';

export type PNav = NativeStackNavigationProp<RootStackParamList, 'Home'>;
export const usePNav = () => useNavigation<PNav>();
