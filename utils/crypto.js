/**
 * utils/crypto.js — WhisperBox E2EE Cryptography
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TECHNOLOGY ANSWERS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ✅ Web Crypto API (window.crypto.subtle)
 *    Used for ALL cryptographic operations — never a third-party library.
 *    - RSA-OAEP 2048-bit key generation     → crypto.subtle.generateKey()
 *    - PBKDF2 key derivation                → crypto.subtle.deriveKey()
 *    - AES-GCM private key encryption       → crypto.subtle.encrypt/decrypt()
 *    - AES-GCM message encryption           → crypto.subtle.encrypt/decrypt()
 *    - RSA-OAEP key exchange                → crypto.subtle.encrypt/decrypt()
 *
 * ✅ JWT — JSON Web Tokens
 *    The WhisperBox SERVER issues JWTs on register/login (access_token +
 *    refresh_token).  We store them in IndexedDB and parse them client-side
 *    in utils/jwt.js for expiry checks.  We never generate JWTs ourselves —
 *    that is the server's job (signed with its secret).
 *
 * ✅ Public key → stored on WhisperBox backend
 *    exportPublicKeyBase64() → SPKI base64 → POST /auth/register { public_key }
 *    Other users fetch it via GET /users/{id}/public-key to encrypt messages for us.
 *
 * ✅ Private key → NEVER leaves the client
 *    - At rest: encrypted blob stored in IndexedDB (wrapped_private_key)
 *    - In memory: live CryptoKey object only — never serialised as plaintext
 *    - Never sent to the server in any form
 *
 * ════════════════════════════════════════════════════════════════════════════
 * KEY SETUP PROTOCOL (on register)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  1. crypto.subtle.generateKey(RSA-OAEP, 2048)
 *     → { publicKey: CryptoKey, privateKey: CryptoKey }
 *
 *  2. generateSalt()
 *     → 128-bit random bytes (base64) for PBKDF2
 *
 *  3. deriveWrappingKey(password, salt)
 *     → PBKDF2(password, salt, 310 000 iters, SHA-256) → AES-GCM-256 CryptoKey
 *        ┌─────────────────────────────────────────────────────────────────┐
 *        │ WHY AES-GCM (not AES-KW)?                                      │
 *        │ AES-KW (RFC 3394) requires the plaintext to be a multiple of   │
 *        │ 8 bytes.  An RSA-2048 PKCS8 DER blob is ~1218 bytes —         │
 *        │ 1218 ÷ 8 = 152.25 → NOT a multiple → browser throws           │
 *        │ "The AES-KW input data length is invalid".                      │
 *        │ AES-GCM has no alignment requirement AND provides              │
 *        │ authenticated encryption (integrity + confidentiality).         │
 *        └─────────────────────────────────────────────────────────────────┘
 *
 *  4. wrapPrivateKey(privateKey, wrappingKey)
 *     → export PKCS8 bytes
 *     → generate random 96-bit IV
 *     → AES-GCM encrypt(PKCS8, wrappingKey, IV)
 *     → store as base64(IV[12] ‖ ciphertext) in IndexedDB + send to server
 *
 *  5. exportPublicKeyBase64(publicKey)
 *     → SPKI base64 → sent to POST /auth/register
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SESSION RESTORE (on login / page refresh)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  1. POST /auth/login → { access_token (JWT), refresh_token (JWT),
 *                           user: { wrapped_private_key, pbkdf2_salt, ... } }
 *  2. deriveWrappingKey(password, pbkdf2_salt) — same as register
 *  3. unwrapPrivateKey(wrapped_private_key, wrappingKey)
 *     → split first 12 bytes as IV, rest as ciphertext
 *     → AES-GCM decrypt → PKCS8 bytes
 *     → crypto.subtle.importKey('pkcs8', ...) → CryptoKey in memory
 *
 * ════════════════════════════════════════════════════════════════════════════
 * MESSAGE ENCRYPTION (per message)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  encryptMessage(plaintext, recipientPublicKey, ownPublicKey)
 *  1. Generate ephemeral AES-GCM-256 key + random 96-bit IV
 *  2. ciphertext = AES-GCM.encrypt(plaintext, aesKey, IV)
 *  3. encryptedKey        = RSA-OAEP.encrypt(rawAesKey, recipientPublicKey)
 *  4. encryptedKeyForSelf = RSA-OAEP.encrypt(rawAesKey, ownPublicKey)
 *  → { ciphertext, iv, encryptedKey, encryptedKeyForSelf } — all base64
 *
 *  decryptMessage(payload, privateKey, currentUserId, fromUserId)
 *  1. Choose encryptedKey (received) or encryptedKeyForSelf (sent by me)
 *  2. rawAesKey = RSA-OAEP.decrypt(encryptedKey, privateKey)
 *  3. aesKey    = importKey('raw', rawAesKey, AES-GCM)
 *  4. plaintext = AES-GCM.decrypt(ciphertext, aesKey, iv)
 */

// ─── RSA Key Generation (Web Crypto API) ─────────────────────────────────────

/**
 * Generate RSA-OAEP 2048-bit keypair using Web Crypto API.
 * Public key  → sent to server (safe to share).
 * Private key → stays on device only; wrapped before any persistence.
 */
export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,           // extractable so we can export for wrapping/sending
    ['encrypt', 'decrypt']
  );
}

// ─── Public Key Export / Import ───────────────────────────────────────────────

/**
 * Export public key to base64 SPKI.
 * This is what gets uploaded to the WhisperBox server at registration.
 * Safe to share — used by others to encrypt messages for us.
 */
export async function exportPublicKeyBase64(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return bufferToBase64(spki);
}

/**
 * Import a public key from base64 SPKI (fetched from GET /users/{id}/public-key).
 * Result is non-extractable — only usable for encryption.
 */
export async function importPublicKeyBase64(base64) {
  const spki = base64ToBuffer(base64);
  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,          // non-extractable on import
    ['encrypt']
  );
}

// ─── PBKDF2 Salt Generation ───────────────────────────────────────────────────

/**
 * Generate a cryptographically random 128-bit PBKDF2 salt.
 * Returned as base64 — sent to server at registration as pbkdf2_salt.
 * The same salt is needed every time you want to re-derive the wrapping key.
 */
export function generateSalt() {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return bufferToBase64(salt);
}

// ─── PBKDF2 → AES-GCM Key Derivation ─────────────────────────────────────────

/**
 * Derive a 256-bit AES-GCM wrapping key from password + salt via PBKDF2.
 *
 * WHY AES-GCM instead of AES-KW:
 *   AES-KW (RFC 3394) requires the input plaintext to be a multiple of 8 bytes.
 *   RSA-2048 private keys exported as PKCS8 DER are ~1218 bytes — which is NOT
 *   a multiple of 8 — causing the browser to throw:
 *     "The AES-KW input data length is invalid: not a multiple of 8 bytes"
 *   AES-GCM has no such restriction and additionally provides authenticated
 *   encryption (detects tampering). The PBKDF2 derivation step is identical
 *   to the WhisperBox spec; only the final cipher is changed from KW to GCM.
 *
 * @param {string} password   — user's password (never stored)
 * @param {string} saltBase64 — base64 128-bit salt from server or generation
 * @returns {CryptoKey} AES-GCM-256 key usable for encrypt/decrypt
 */
export async function deriveWrappingKey(password, saltBase64) {
  const saltBuffer = base64ToBuffer(saltBase64);

  // Import password as a PBKDF2 base key
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES-GCM-256 from the password + salt
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 310_000,   // OWASP 2024 recommendation for PBKDF2-SHA256
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },   // AES-GCM (not AES-KW — see above)
    false,                               // non-extractable
    ['encrypt', 'decrypt']
  );
}

// ─── Private Key Wrap / Unwrap ────────────────────────────────────────────────

/**
 * Encrypt (wrap) the RSA private key for secure storage.
 *
 * Process:
 *   1. Export privateKey → PKCS8 DER bytes
 *   2. Generate random 96-bit IV
 *   3. AES-GCM encrypt PKCS8 bytes with wrappingKey
 *   4. Return base64( IV[12 bytes] ‖ ciphertext ) — a single blob
 *
 * The result is stored:
 *   - In IndexedDB (as wrapped_private_key in the session record)
 *   - On the WhisperBox server (as wrapped_private_key field on the user)
 *
 * The PLAINTEXT private key never appears in either location.
 *
 * @param {CryptoKey} privateKey   — RSA-OAEP private key (generated at register)
 * @param {CryptoKey} wrappingKey  — AES-GCM key from deriveWrappingKey()
 * @returns {string} base64 blob = IV ‖ encrypted PKCS8
 */
export async function wrapPrivateKey(privateKey, wrappingKey) {
  // Step 1: Export to raw PKCS8 bytes
  const pkcs8Bytes = await crypto.subtle.exportKey('pkcs8', privateKey);

  // Step 2: Fresh random 96-bit (12-byte) IV — never reuse IVs
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Step 3: AES-GCM encrypt — no alignment requirement, adds auth tag
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    pkcs8Bytes
  );

  // Step 4: Combine IV + ciphertext into one blob (IV must travel with ciphertext)
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return bufferToBase64(combined.buffer);
}

/**
 * Decrypt (unwrap) the RSA private key from its stored blob.
 *
 * Process:
 *   1. base64-decode the blob → split first 12 bytes as IV, rest as ciphertext
 *   2. AES-GCM decrypt → PKCS8 DER bytes
 *   3. importKey('pkcs8', ...) → CryptoKey (non-extractable, in memory only)
 *
 * The returned CryptoKey stays in memory (via whisperbox.js _privateKey).
 * It is NEVER serialised or stored again after this point.
 *
 * @param {string}    wrappedBase64 — the blob from wrapPrivateKey() / server
 * @param {CryptoKey} wrappingKey   — AES-GCM key re-derived from password+salt
 * @returns {CryptoKey} RSA-OAEP private key ready for decryption
 */
export async function unwrapPrivateKey(wrappedBase64, wrappingKey) {
  const combined = new Uint8Array(base64ToBuffer(wrappedBase64));

  // Split IV (first 12 bytes) from ciphertext (everything after)
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // AES-GCM decrypt → raw PKCS8 bytes (also verifies auth tag — detects tampering)
  const pkcs8Bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    ciphertext
  );

  // Import the PKCS8 bytes as a non-extractable CryptoKey
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8Bytes,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,           // non-extractable — stays in memory only
    ['decrypt']
  );
}

// ─── Message Encryption ───────────────────────────────────────────────────────

/**
 * Encrypt a message for a recipient.
 * Returns the WhisperBox payload object.
 *
 * @param {string}    plaintext
 * @param {CryptoKey} recipientPublicKey
 * @param {CryptoKey} ownPublicKey       — needed for encryptedKeyForSelf
 */
export async function encryptMessage(plaintext, recipientPublicKey, ownPublicKey) {
  // Fresh AES-GCM key + IV per message
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt content
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);

  // Export raw AES key for RSA wrapping
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);

  // Wrap for recipient (they decrypt with their private key)
  const encryptedKey = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    recipientPublicKey,
    rawAesKey
  );

  // Wrap for self (sender can read their own sent messages)
  const encryptedKeyForSelf = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    ownPublicKey,
    rawAesKey
  );

  return {
    ciphertext: bufferToBase64(cipherBuffer),
    iv: bufferToBase64(iv),
    encryptedKey: bufferToBase64(encryptedKey),
    encryptedKeyForSelf: bufferToBase64(encryptedKeyForSelf),
  };
}

// ─── Message Decryption ───────────────────────────────────────────────────────

/**
 * Decrypt a WhisperBox message payload.
 * Uses encryptedKeyForSelf if sent by currentUser, else encryptedKey.
 *
 * @param {Object}    payload        — { ciphertext, iv, encryptedKey, encryptedKeyForSelf }
 * @param {CryptoKey} privateKey     — own RSA private key (unwrapped at login)
 * @param {string}    currentUserId
 * @param {string}    fromUserId
 */
export async function decryptMessage(payload, privateKey, currentUserId, fromUserId) {
  const { ciphertext, iv, encryptedKey, encryptedKeyForSelf } = payload;
  const isSentByMe = fromUserId === currentUserId;
  const encryptedAesKeyBase64 = isSentByMe ? encryptedKeyForSelf : encryptedKey;

  if (!encryptedAesKeyBase64) throw new Error('No decryptable key in payload');

  // Decrypt AES key with RSA private key
  const rawAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    base64ToBuffer(encryptedAesKeyBase64)
  );

  // Import decrypted AES key
  const aesKey = await crypto.subtle.importKey(
    'raw', rawAesKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );

  // AES-GCM decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    aesKey,
    base64ToBuffer(ciphertext)
  );

  return new TextDecoder().decode(decrypted);
}

// ─── Key Fingerprint ──────────────────────────────────────────────────────────

export async function getKeyFingerprint(publicKeyBase64) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', base64ToBuffer(publicKeyBase64));
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16)
      .toUpperCase()
      .match(/.{1,4}/g)
      .join(':');
  } catch {
    return 'UNKNOWN';
  }
}

// ─── Buffer ↔ Base64 ──────────────────────────────────────────────────────────

export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBuffer(base64) {
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return buffer.buffer;
}
