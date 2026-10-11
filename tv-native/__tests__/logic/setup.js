// react-test-renderer says it is deprecated on every create(); nothing else is hidden.
const error = console.error.bind(console);
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
  error(...args);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
