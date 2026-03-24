import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Get encryption key from env. Returns null if not configured.
 * In production, set TOKEN_ENCRYPTION_KEY to a 32-byte hex string (64 hex chars).
 */
function getEncryptionKey(): Buffer | null {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes), got ${key.length} chars / ${buf.length} bytes`
    );
  }
  return buf;
}

/**
 * Encrypt a string. Returns base64-encoded ciphertext (iv + tag + encrypted).
 * If TOKEN_ENCRYPTION_KEY is not set, returns the plaintext (backward-compatible).
 */
export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a string. If it doesn't look like an encrypted value, returns as-is
 * (backward-compatible with plaintext tokens stored before encryption was enabled).
 */
export function decryptToken(stored: string): string {
  const key = getEncryptionKey();
  if (!key) return stored;

  // Minimum length: iv(12) + tag(16) + at least 1 byte ciphertext = 29 bytes
  // Base64 of 29 bytes = 40 chars. GitHub tokens are "gho_..." / "ghu_..." format,
  // so a plaintext token won't be valid base64 of that structure.
  const buf = Buffer.from(stored, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    // Too short to be encrypted — treat as legacy plaintext token
    return stored;
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    // Decryption failed — likely a plaintext token from before encryption was enabled.
    // Log for visibility but don't crash the request.
    console.warn("Token decryption failed — treating as plaintext (pre-encryption migration).");
    return stored;
  }
}
