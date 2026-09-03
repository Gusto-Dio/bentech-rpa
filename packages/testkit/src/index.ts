/**
 * @rpa/testkit - fakes and fixtures for testing automations.
 *
 * A devDependency for automations. Nothing here is used at runtime, and the
 * production image never needs it.
 */
export { FakeSession } from './FakeSession.ts';
export { InMemoryQueueProvider } from './InMemoryQueueProvider.ts';
export {
  MapSecretProvider,
  createTestLogger,
  createTestManifest,
  createTestQueueItem,
  createTestTxContext,
  type TestContextOptions,
} from './fixtures.ts';
