// App-wide toasts (the site's ui.js toast()), for the moments that happen
// outside a screen's own UI: a party member joining, a download landing, a
// report sent. The Toasts component in components/Overlays.tsx draws them.
import {useEffect, useState} from 'react';

export type Toast = {id: number; text: string; glyph?: string};
let list: Toast[] = [];
let nextId = 1;
const subs = new Set<(t: Toast[]) => void>();
const emit = () => {
  for (const fn of subs) fn(list);
};

export const showToast = (text: string, glyph?: string, ms = 3800) => {
  const t = {id: nextId++, text, glyph};
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
