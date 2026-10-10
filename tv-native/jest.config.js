module.exports = {
  preset: '@react-native/jest-preset',
  // __tests__/logic runs on plain node with its own config (jest.logic.config.js)
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/logic/'],
};
