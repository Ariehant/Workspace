import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

// scrypt with N=2^15, r=8, p=1: about 32 MB and ~50 ms per hash.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

const derive = (password: string, salt: Buffer, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password.normalize('NFC'),
      salt,
      KEY_LENGTH,
      { ...options, maxmem: 128 * options.N! * options.r! * 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

/** `scrypt$N$r$p$salt$hash` (base64url), so the parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Checked when no account matches, so the response takes as long as a real check. */
let dummy: Promise<string> | null = null;
export async function verifyNothing(password: string): Promise<false> {
  dummy ??= hashPassword('not a password');
  await verifyPassword(password, await dummy);
  return false;
}

/** Why a new password isn't acceptable, or null. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'A password is required.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'That password is too long.';
  return null;
}

/** A random secret for tokens and codes (256 bits, base64url). */
export const randomToken = () => randomBytes(32).toString('base64url');
