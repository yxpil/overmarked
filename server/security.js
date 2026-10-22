import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (![N, r, p].every(Number.isFinite) || N > 1048576 || r > 32 || p > 16) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length < 8 || expected.length < 16) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// 与真实校验耗时接近，降低用户名枚举的时序差异
export function burnPasswordCheck(password) {
  try {
    crypto.scryptSync(password, 'overmarked-fixed-salt', KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAXMEM,
    });
  } catch {
    /* ignore */
  }
}
