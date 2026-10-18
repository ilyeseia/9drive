import { setVerbose } from '../core/logger';

// Official in-memory mock: AsyncStorage needs a native module that does not exist under Jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// NetInfo is a native module; the package ships an official Jest mock (always online unless a test overrides it).
jest.mock('@react-native-community/netinfo', () => jest.requireActual('@react-native-community/netinfo/jest/netinfo-mock.js'));

// Keep test output readable; individual tests that assert on logging attach their own sink.
setVerbose(false);
