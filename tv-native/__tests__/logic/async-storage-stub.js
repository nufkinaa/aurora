// @react-native-async-storage/async-storage for the logic tests: a Map.
// `__store` is the Map itself, for a test to seed or read.
const store = new Map();
module.exports = {
  __esModule: true,
  __store: store,
  default: {
    getItem: k => Promise.resolve(store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
      return Promise.resolve();
    },
    removeItem: k => {
      store.delete(k);
      return Promise.resolve();
    },
  },
};
