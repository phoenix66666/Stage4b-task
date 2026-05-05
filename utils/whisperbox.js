/**
 * utils/whisperbox.js — WhisperBox API Client
 *
 * Full client for https://whisperbox.koyeb.app
 * Handles auth, token refresh, users, conversations, messages, WebSocket.
 *
 * Security notes:
 *  - Tokens stored in memory (_memTokens); persisted in IndexedDB via indexeddb.js
 *  - Access token: 15-min TTL — auto-refreshed before expiry
 *  - Private key: CryptoKey in memory only (_privateKey), never serialised here
 */

export const BASE_URL = 'https://whisperbox.koyeb.app';
export const WS_URL = 'wss://whisperbox.koyeb.app';

// ─── In-Memory State ──────────────────────────────────────────────────────────

let _memTokens = { access: null, refresh: null };
let _privateKey = null;   // CryptoKey — set after login/unlock, never serialised
let _ownPublicKey = null; // base64 — needed for encryptedKeyForSelf

// Token accessors
export const getAccessToken = () => _memTokens.access;
export const getRefreshToken = () => _memTokens.refresh;
export const getPrivateKey = () => _privateKey;
export const getOwnPublicKey = () => _ownPublicKey;

export function setTokens(access, refresh) {
  _memTokens = { access, refresh };
}
export function setPrivateKey(key) { _privateKey = key; }
export function setOwnPublicKey(pubKey) { _ownPublicKey = pubKey; }

export function clearSession() {
  _memTokens = { access: null, refresh: null };
  _privateKey = null;
  _ownPublicKey = null;
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

let _isRefreshing = false;
let _refreshQueue = [];

async function request(path, options = {}, retry = true) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (_memTokens.access) headers['Authorization'] = `Bearer ${_memTokens.access}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // Auto-refresh on 401
  if (res.status === 401 && retry && _memTokens.refresh) {
    if (_isRefreshing) {
      // Queue while refresh is in progress
      return new Promise((resolve, reject) => {
        _refreshQueue.push({ resolve, reject, path, options });
      });
    }
    _isRefreshing = true;
    try {
      const refreshed = await refreshToken();
      if (refreshed) {
        // Replay queued requests
        _refreshQueue.forEach(({ resolve, reject, path: p, options: o }) =>
          request(p, o, false).then(resolve).catch(reject)
        );
        _refreshQueue = [];
        return request(path, options, false);
      }
    } catch {
      _refreshQueue.forEach(({ reject }) => reject(new Error('Session expired')));
      _refreshQueue = [];
    } finally {
      _isRefreshing = false;
    }
  }

  if (!res.ok) {
    let errData;
    try { errData = await res.json(); } catch { errData = {}; }
    const err = new Error(errData.detail || errData.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = errData;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Register a new account.
 * All key material generated client-side before calling this.
 *
 * @param {Object} params
 * @param {string} params.username
 * @param {string} params.display_name
 * @param {string} params.password
 * @param {string} params.public_key        — base64 SPKI RSA public key
 * @param {string} params.wrapped_private_key — base64 AES-KW wrapped private key
 * @param {string} params.pbkdf2_salt         — base64 128-bit salt
 */
export async function register({ username, display_name, password, public_key, wrapped_private_key, pbkdf2_salt }) {
  const data = await request('/auth/register', {
    method: 'POST',
    body: { username, display_name, password, public_key, wrapped_private_key, pbkdf2_salt },
  });
  setTokens(data.access_token, data.refresh_token);
  return data;
}

/**
 * Login. Returns { access_token, refresh_token, user }.
 * After this, call deriveWrappingKey + unwrapPrivateKey to restore crypto.
 */
export async function login(username, password) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  setTokens(data.access_token, data.refresh_token);
  return data;
}

/** Get current user profile (includes wrapped_private_key + pbkdf2_salt). */
export async function getMe() {
  return request('/auth/me');
}

/** Refresh access token; returns new access_token or null on failure. */
export async function refreshToken() {
  if (!_memTokens.refresh) return null;
  try {
    const data = await request('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: _memTokens.refresh },
    }, false);
    setTokens(data.access_token, _memTokens.refresh);
    return data.access_token;
  } catch {
    return null;
  }
}

/** Logout — revokes refresh token. */
export async function logout() {
  try {
    if (_memTokens.refresh) {
      await request('/auth/logout', {
        method: 'POST',
        body: { refresh_token: _memTokens.refresh },
      }, false);
    }
  } finally {
    clearSession();
  }
}

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * Search users by username or display name.
 * Returns [{ id, username, display_name }]
 */
export async function searchUsers(query) {
  return request(`/users/search?q=${encodeURIComponent(query)}`);
}

/**
 * Get a user's RSA public key (base64 SPKI).
 * Returns { public_key: string }
 */
export async function getUserPublicKey(userId) {
  return request(`/users/${userId}/public-key`);
}

// ─── Conversations ────────────────────────────────────────────────────────────

/**
 * List all conversations (most recent first).
 * Returns [{ user_id, username, display_name, last_message_at }]
 */
export async function getConversations() {
  return request('/conversations');
}

/**
 * Get paginated message history with a user (newest first).
 * @param {string} userId
 * @param {Object} opts   { limit?: number, before?: ISO string }
 */
export async function getMessages(userId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', opts.limit);
  if (opts.before) params.set('before', opts.before);
  const qs = params.toString() ? `?${params}` : '';
  return request(`/conversations/${userId}/messages${qs}`);
}

// ─── Messages (REST fallback) ─────────────────────────────────────────────────

/**
 * Send an encrypted message via REST (WebSocket fallback).
 * Prefer WebSocket for real-time delivery.
 *
 * @param {string} to       — recipient UUID
 * @param {Object} payload  — { ciphertext, iv, encryptedKey, encryptedKeyForSelf }
 */
export async function sendMessage(to, payload) {
  return request('/messages', {
    method: 'POST',
    body: { to, payload },
  });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

/**
 * Connect to the WhisperBox WebSocket.
 * Returns a WebSocket instance.
 *
 * Events emitted on the socket:
 *   message.receive  — { id, from_user_id, to_user_id, payload, created_at }
 *   user.online      — { user_id }
 *   user.offline     — { user_id }
 *   error            — { detail }
 *
 * @param {Object} handlers — { onMessage, onOnline, onOffline, onError, onClose, onOpen }
 */
export function connectWebSocket(handlers = {}) {
  if (!_memTokens.access) throw new Error('No access token for WebSocket');

  const ws = new WebSocket(`${WS_URL}/ws?token=${_memTokens.access}`);

  ws.onopen = () => {
    handlers.onOpen?.();
  };

  ws.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (frame.event) {
      case 'message.receive':
        handlers.onMessage?.(frame);
        break;
      case 'user.online':
        handlers.onOnline?.(frame.user_id);
        break;
      case 'user.offline':
        handlers.onOffline?.(frame.user_id);
        break;
      case 'error':
        handlers.onError?.(frame.detail);
        break;
    }
  };

  ws.onclose = (e) => handlers.onClose?.(e);
  ws.onerror = (e) => handlers.onError?.('WebSocket error');

  return ws;
}

/**
 * Send a message over an open WebSocket.
 * @param {WebSocket} ws
 * @param {string}    to
 * @param {Object}    payload
 */
export function wsSendMessage(ws, to, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected');
  }
  ws.send(JSON.stringify({ event: 'message.send', to, payload }));
}

// ─── Server Health ────────────────────────────────────────────────────────────

export async function checkHealth() {
  return request('/health', {}, false);
}
