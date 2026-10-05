// AsyncStorage over localStorage. Every frame on the sandbox page shares it, so
// signing in once signs every size in.
const P = 'aurora-tv:';
const ls = () => window.localStorage;

const AsyncStorage = {
  getItem: async k => ls().getItem(P + k),
  setItem: async (k, v) => {
    ls().setItem(P + k, String(v));
  },
  removeItem: async k => {
    ls().removeItem(P + k);
  },
  mergeItem: async (k, v) => {
    let a = {};
    try {
      a = JSON.parse(ls().getItem(P + k) || '{}');
    } catch {}
    ls().setItem(P + k, JSON.stringify({...a, ...JSON.parse(v)}));
  },
  getAllKeys: async () =>
    Object.keys(ls())
      .filter(k => k.startsWith(P))
      .map(k => k.slice(P.length)),
  multiGet: async keys => keys.map(k => [k, ls().getItem(P + k)]),
  multiSet: async pairs => {
    for (const [k, v] of pairs) ls().setItem(P + k, String(v));
  },
  multiRemove: async keys => {
    for (const k of keys) ls().removeItem(P + k);
  },
  clear: async () => {
    for (const k of Object.keys(ls())) if (k.startsWith(P)) ls().removeItem(k);
  },
};

export default AsyncStorage;
export const useAsyncStorage = k => ({
  getItem: () => AsyncStorage.getItem(k),
  setItem: v => AsyncStorage.setItem(k, v),
  removeItem: () => AsyncStorage.removeItem(k),
});
