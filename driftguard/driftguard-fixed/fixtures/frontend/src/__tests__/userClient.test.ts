/**
 * Seeded fixture, same convention as the DRIFTED/silent-drift comments
 * elsewhere in fixtures/frontend: this file exists so the per-impact
 * coverage signal (src/graph/TestCoverageResolver.ts) has a real
 * tested-vs-untested contrast to resolve against, instead of every
 * consumer in this fixture repo coming back untested by default.
 */
import { getUser } from '../api/userClient';

test('getUser returns a user', async () => {
  const user = await getUser('1');
  expect(user).toBeDefined();
});
