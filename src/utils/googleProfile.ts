export interface GoogleUserProfile {
  subject?: string;
  email: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  name?: string;
  picture?: string;
}

function cleanNamePart(value?: string): string {
  return value?.trim().replace(/\s+/g, ' ') || '';
}

function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const parts = cleanNamePart(displayName).split(' ').filter(Boolean);
  return {
    firstName: parts.shift() || 'Google',
    lastName: parts.join(' '),
  };
}

export function normalizeGoogleName(profile: GoogleUserProfile): { firstName: string; lastName: string } {
  const firstName = cleanNamePart(profile.firstName);
  const lastName = cleanNamePart(profile.lastName);
  const fullName = cleanNamePart(profile.name);

  // Some Google profiles accidentally contain the same display name in both
  // fields. Store it once so the application does not render it twice.
  if (firstName && lastName && firstName.localeCompare(lastName, undefined, { sensitivity: 'accent' }) === 0) {
    return splitDisplayName(firstName);
  }

  if (firstName && lastName) return { firstName, lastName };
  if (fullName) return splitDisplayName(fullName);
  if (firstName || lastName) return splitDisplayName(firstName || lastName);
  return { firstName: 'Google', lastName: 'User' };
}
