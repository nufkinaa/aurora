// Logic tests that need no React Native runtime: `react-native` is a small
// stub (__tests__/logic/rn-stub.js), so they run on plain node.
//   npx jest -c jest.logic.config.js
// (The default config's preset, @react-native/jest-preset, is not installed.)
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/__tests__/logic/setup.js'],
  testMatch: ['<rootDir>/__tests__/logic/**/*.test.(ts|tsx)'],
  transform: {'^.+\.(js|jsx|ts|tsx)$': 'babel-jest'},
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__tests__/logic/rn-stub.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/__tests__/logic/async-storage-stub.js',
    '\.png$': '<rootDir>/__tests__/logic/asset-stub.js',
  },
};
