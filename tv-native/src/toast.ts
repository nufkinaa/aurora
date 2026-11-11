// App-wide toasts (the site's ui.js toast()), for the moments that happen
// outside a screen's own UI: a party member joining, a download landing, a
// report sent. The Toasts component in components/Overlays.tsx draws them.
import {useEffect, useState} from 'react';
import {trail} from './trail'; // [report trail] the words of every toast shown

// `action`: one press on the toast itself (the phone's Undo after a Remove — the TV draws
// toasts without it)
export type ToastAction = {label: string; onPress: () => void};
export type Toast = {id: number; text: string; glyph?: string; action?: ToastAction};
let list: Toast[] = [];
let nextId = 1;
const subs = new Set<(t: Toast[]) => void>();
const emit = () => {
  for (const fn of subs) fn(list);
};

export const showToast = (text: string, glyph?: string, ms = 3800, action?: ToastAction) => {
  trail('toast', {m: text});
  const t: Toast = {id: nextId++, text, glyph, ...(action ? {action} : {})};
  list = [...list.slice(-2), t]; // never more than three stacked
  emit();
  setTimeout(() => {
    list = list.filter(x => x.id !== t.id);
    emit();
  }, ms);
};

export const useToasts = () => {
  const [state, setState] = useState(list);
  useEffect(() => {
    subs.add(setState);
    return () => {
      subs.delete(setState);
    };
  }, []);
  return state;
};

/** Take a toast down now (its action was pressed). */
export const dropToast = (id: number) => {
  list = list.filter(x => x.id !== id);
  emit();
};
