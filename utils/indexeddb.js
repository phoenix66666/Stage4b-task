/**
 * utils/indexeddb.js — Secure client-side storage for WhisperBox
 *
 * DB: 'WhisperBoxSecure' v2
 * Stores:
 *   session — { id, access_token, refresh_token, user_id, username, display_name,
 *               public_key, wrapped_private_key, pbkdf2_salt, stored_at }
 *
 * The private key is NEVER stored here — it lives only in memory as a CryptoKey.
 * wrapped_private_key is the server-stored blob (also cached locally for offline
 * session restore — user still needs their password to unwrap it).
 */

const DB_NAME = 'WhisperBoxSecure';
const DB_VERSION = 2;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Drop old stores on version upgrade
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      // Single session store
      db.createObjectStore('session', { keyPath: 'id' });
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(new Error(`IndexedDB: ${e.target.errorCode}`));
  });
}

function tx(storeName, mode, fn) {
  return openDB().then((db) =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const req = fn(store);
      if (req) {
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      } else {
        transaction.oncomplete = () => resolve();
        transaction.onerror = (e) => reject(e.target.error);
      }
    })
  );
}

// ─── Session ──────────────────────────────────────────────────────────────────

const SESSION_ID = 'current';

/**
 * Save a session to IndexedDB.
 * @param {Object} params
 * @param {string} params.access_token
 * @param {string} params.refresh_token
 * @param {Object} params.user — { id, username, display_name, public_key, wrapped_private_key, pbkdf2_salt }
 */
export async function saveSession({ access_token, refresh_token, user }) {
  return tx('session', 'readwrite', (store) =>
    store.put({
      id: SESSION_ID,
      access_token,
      refresh_token,
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      public_key: user.public_key,
      wrapped_private_key: user.wrapped_private_key,
      pbkdf2_salt: user.pbkdf2_salt,
      stored_at: Date.now(),
    })
  );
}

/** Update tokens in the stored session (after refresh). */
export async function updateSessionTokens(access_token, refresh_token) {
  const session = await getSession();
  if (!session) return;
  return tx('session', 'readwrite', (store) =>
    store.put({ ...session, access_token, ...(refresh_token && { refresh_token }) })
  );
}

/** Retrieve stored session. Returns null if none. */
export async function getSession() {
  try {
    return await tx('session', 'readonly', (store) => store.get(SESSION_ID));
  } catch {
    return null;
  }
}

/** Clear all session data (logout). */
export async function clearStoredSession() {
  return tx('session', 'readwrite', (store) => store.delete(SESSION_ID));
}

/** Check if a session exists. */
export async function hasSession() {
  const s = await getSession();
  return !!s;
}
