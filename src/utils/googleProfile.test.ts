import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGoogleName } from './googleProfile';

const baseProfile = {
  email: 'person@gmail.com',
  emailVerified: true,
};

test('keeps distinct Google first and last names', () => {
  assert.deepEqual(
    normalizeGoogleName({ ...baseProfile, firstName: 'Casha-Ba', lastName: 'Admin' }),
    { firstName: 'Casha-Ba', lastName: 'Admin' },
  );
});

test('removes an accidentally duplicated Google display name', () => {
  assert.deepEqual(
    normalizeGoogleName({ ...baseProfile, firstName: 'Casha-Ba Admin', lastName: 'Casha-Ba Admin' }),
    { firstName: 'Casha-Ba', lastName: 'Admin' },
  );
});

test('uses the Google full name when individual name fields are missing', () => {
  assert.deepEqual(
    normalizeGoogleName({ ...baseProfile, name: 'Demo User' }),
    { firstName: 'Demo', lastName: 'User' },
  );
});

test('normalizes extra whitespace', () => {
  assert.deepEqual(
    normalizeGoogleName({ ...baseProfile, firstName: '  Maria  Clara ', lastName: ' Santos  ' }),
    { firstName: 'Maria Clara', lastName: 'Santos' },
  );
});
