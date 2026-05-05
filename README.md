# WhisperBox — E2EE Messaging (WhisperBox API Backend)

A secure messaging app backed by `https://whisperbox.koyeb.app`.  
The server **never** sees plaintext — all encryption/decryption happens in the browser.

---

## Quick Start

```bash
unzip my-messaging-app.zip && cd my-messaging-app
npm install
npm run dev
# → http://localhost:3000
```

No `.env` needed — everything hits the live WhisperBox API.

---

## Encryption Protocol 

### Registration
1. **`generateKeyPair()`** — RSA-OAEP 2048-bit keypair in the browser
2. **`generateSalt()`** — random 128-bit PBKDF2 salt
3. **`deriveWrappingKey(password, salt)`** — PBKDF2 (310k iters, SHA-256) → AES-KW 256-bit
4. **`wrapPrivateKey(privateKey, wrappingKey)`** — AES-KW wraps private key → base64 blob
5. **`exportPublicKeyBase64(publicKey)`** — SPKI → base64
6. **`POST /auth/register`** — uploads `public_key`, `wrapped_private_key`, `pbkdf2_salt`
7. Private key goes into memory (`setPrivateKey()`), **never stored in plaintext**

### Login / Session Restore
1. **`POST /auth/login`** — server returns `wrapped_private_key` + `pbkdf2_salt`
2. **`deriveWrappingKey(password, salt)`** — re-derive from user's password
3. **`unwrapPrivateKey(wrappedBlob, wrappingKey)`** — CryptoKey back in memory
4. If page is refreshed → **Unlock Modal** prompts for password to re-unwrap

### Sending a Message
1. Fetch recipient's RSA public key: `GET /users/{id}/public-key`
2. **`encryptMessage(plaintext, recipientPublicKey, ownPublicKey)`**
   - Fresh AES-GCM 256-bit key + 96-bit IV per message
   - `ciphertext` = AES-GCM encrypted content
   - `encryptedKey` = AES key wrapped with **recipient's** RSA public key
   - `encryptedKeyForSelf` = AES key wrapped with **sender's own** RSA public key
3. Send via **WebSocket** (`message.send`) — falls back to `POST /messages`

### Receiving a Message
1. Arrive via WebSocket `message.receive` or `GET /conversations/{id}/messages`
2. **`decryptMessage(payload, privateKey)`**
   - Chooses `encryptedKey` (received) or `encryptedKeyForSelf` (sent by me)
   - RSA-OAEP decrypts → raw AES key → AES-GCM decrypts → plaintext

---

## File Map

| File | Role |
|------|------|
| `utils/crypto.js` | All Web Crypto API: RSA keygen, PBKDF2, AES-KW wrap/unwrap, AES-GCM encrypt/decrypt |
| `utils/whisperbox.js` | Full WhisperBox API client: auth, users, conversations, messages, WebSocket |
| `utils/indexeddb.js` | Persists session (tokens + wrapped key blobs) in IndexedDB — no localStorage |
| `utils/jwt.js` | Client-side JWT parsing, expiry checks, auto-refresh scheduling |
| `pages/login.js` | Register + login with full crypto flow + progress steps UI |
| `pages/index.js` | Main app: session restore, WebSocket management, unlock modal, token refresh |
| `components/UserList.js` | Conversations list + user search (`GET /users/search`) |
| `components/ChatWindow.js` | Fetch history, decrypt in-browser, handle live WS messages |
| `components/MessageInput.js` | Encrypt before send, WS-first with REST fallback |

---

## Key Security Properties

| Property | Detail |
|----------|--------|
| Private key storage | AES-KW wrapped in IndexedDB; plaintext only in memory as `CryptoKey` |
| Token storage | Access + refresh tokens in IndexedDB (not `localStorage`) |
| Server knowledge | Sees only ciphertext, IVs, and RSA-encrypted AES key blobs |
| Key wrapping | PBKDF2 310k iterations, SHA-256, 256-bit AES-KW |
| Message encryption | AES-256-GCM, fresh key + random 96-bit IV per message |
| Key exchange | RSA-OAEP 2048-bit, SHA-256 |
| Token lifetime | Access: 15 min (auto-refreshed 90s before expiry) |
| Real-time | WebSocket with auto-reconnect; REST fallback if WS unavailable |

---

## API Endpoints Used

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/register` | Create account + upload public key |
| POST | `/auth/login` | Authenticate + get wrapped private key back |
| GET | `/auth/me` | Verify session |
| POST | `/auth/refresh` | Renew access token |
| POST | `/auth/logout` | Revoke refresh token |
| GET | `/users/search?q=` | Find users to message |
| GET | `/users/{id}/public-key` | Fetch recipient's RSA public key |
| GET | `/conversations` | List all conversations |
| GET | `/conversations/{id}/messages` | Paginated message history |
| POST | `/messages` | Send message (REST fallback) |
| WS | `/ws?token=` | Real-time messaging + presence |
