import { setVerbose } from '../core/logger';

// Official in-memory mock: AsyncStorage needs a native module that does not exist under Jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Keep test output readable; individual tests that assert on logging attach their own sink.
setVerbose(false);
