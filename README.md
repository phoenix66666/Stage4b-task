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
## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                          BROWSER  (Client)                             │
│                                                                        │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  pages/         │  │  components/     │  │  utils/crypto.js     │  │
│  │  login.js       │  │  ChatWindow.js   │  │                      │  │
│  │  index.js       │  │  MessageInput.js │  │  Web Crypto API      │  │
│  └────────┬────────┘  │  UserList.js     │  │  window.crypto.subtle│  │
│           │           └────────┬─────────┘  │  ┌──────────────┐   │  │
│           └────────────────────┤            │  │ RSA-OAEP     │   │  │
│                                ▼            │  │ AES-GCM      │   │  │
│                    ┌───────────────────┐    │  │ PBKDF2       │   │  │
│                    │ utils/            │    │  │ SHA-256      │   │  │
│                    │ whisperbox.js     │    │  └──────────────┘   │  │
│                    │                   │    └──────────────────────┘  │
│                    │ • HTTP REST       │                              │
│                    │ • WebSocket       │  ┌──────────────────────┐    │
│                    │ • JWT headers     │  │  utils/indexeddb.js  │    │
│                    │ • Token refresh   │  │                      │    │
│                    └────────┬──────────┘  │  IndexedDB           │    │
│                             │             │  • access_token (JWT)│    │
│                             │             │  • refresh_token     │    │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │  ─ ─ ─ ─   │  • wrapped_priv_key  │    │
│   PRIVATE KEY NEVER CROSSES │            │  • pbkdf2_salt       │    │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │  ─ ─ ─ ─   │  • public_key        │    │
│                             │             └──────────────────────┘    │
└─────────────────────────────┼──────────────────────────────────────────┘
                              │
                 HTTPS + WSS  │  (ciphertext, JWTs, public keys only)
                              │
┌─────────────────────────────┼──────────────────────────────────────────┐
│              WhisperBox API  │  https://whisperbox.koyeb.app           │
│                             │                                          │
│        ┌────────────────────┼─────────────────────┐                   │
│        │                    │                     │                   │
│  ┌─────▼──────┐   ┌─────────▼──────┐   ┌──────────▼──────┐           │
│  │ /auth/*    │   │ /users/*       │   │ /conversations  │           │
│  │            │   │                │   │ /messages       │           │
│  │ Issues JWT │   │ Stores and     │   │                 │           │
│  │ access +   │   │ serves RSA     │   │ Stores ONLY     │           │
│  │ refresh    │   │ public keys.   │   │ encrypted blobs │           │
│  │ tokens     │   │                │   │ — never sees    │           │
│  │            │   │ Also stores    │   │ plaintext       │           │
│  │ Stores:    │   │ wrapped_priv   │   │                 │           │
│  │ hashed pwd │   │ _key + salt    │   │                 │           │
│  └────────────┘   └────────────────┘   └─────────────────┘           │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │  WebSocket  wss://whisperbox.koyeb.app/ws?token=<JWT>         │   │
│  │  • message.receive — encrypted payload in real-time            │   │
│  │  • user.online / user.offline — presence events               │   │
│  └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘

  What the server STORES              What the server NEVER SEES
  ────────────────────────────        ───────────────────────────────
  ✓ RSA public keys                   ✗ RSA private keys (plaintext)
  ✓ AES-GCM-encrypted priv key blobs  ✗ Message plaintext
  ✓ PBKDF2 salts                      ✗ Per-message AES-GCM keys
  ✓ AES-GCM ciphertext of messages    ✗ User passwords (hashed only)
  ✓ RSA-OAEP-wrapped AES keys         ✗ Decrypted content of any kind
  ✓ JWT access + refresh tokens
```
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
## Key Management

### Public Key

| Property | Detail |
|---|---|
| Algorithm | RSA-OAEP, 2048-bit modulus, SHA-256 hash |
| Format at rest | SPKI, base64-encoded |
| Generated | `crypto.subtle.generateKey()` in browser at registration |
| Stored | WhisperBox server (safe to share — used for encryption only) |
| Transport | Uploaded at `POST /auth/register`. Fetched by others at `GET /users/{id}/public-key` |
| Purpose | Encrypts per-message AES keys for the intended recipient |

The public key is not secret. Anyone who wants to send an encrypted message must have it, so it lives on the server and is freely returned by the API.

### Private Key

| Property | Detail |
|---|---|
| Algorithm | RSA-OAEP, 2048-bit, SHA-256 |
| In memory | Non-extractable `CryptoKey` — cannot be serialised by any JavaScript |
| At rest | AES-256-GCM encrypted blob: `base64( IV[12 bytes] ‖ ciphertext )` |
| Persistent storage | IndexedDB (encrypted blob) AND WhisperBox server (encrypted blob) |
| Sent to server in plaintext? | **Never.** Only the encrypted blob is stored server-side |
| Lost if | Device storage is wiped AND user cannot recover password |
| Purpose | Decrypts per-message AES keys received in message payloads |


### Session Keys (JWT)

WhisperBox issues two JWTs on every login or register:

| Token | Lifetime | Purpose | Stored |
|---|---|---|---|
| `access_token` | 15 minutes | Authorises all REST + WebSocket calls | IndexedDB + JS memory |
| `refresh_token` | Long-lived | Gets a new access token via `/auth/refresh` | IndexedDB |

The client schedules automatic refresh 90 seconds before the access token expires, then reconnects the WebSocket with the new token. Tokens are stored in **IndexedDB** rather than `localStorage` — `localStorage` is synchronously accessible to any injected script, while IndexedDB requires an async API call, providing a marginal but meaningful barrier against trivial XSS exfiltration.

---

## Security Trade-offs

### What this design gets right

**Server compromise does not expose messages.** A full database breach reveals only ciphertext blobs and RSA-encrypted AES keys. Without the private keys — which are never stored in plaintext anywhere — the data is not useful to an attacker.

**Password never stored or transmitted.** The password is used once to derive the wrapping key, then immediately garbage-collected. The server stores only a bcrypt hash. The wrapping key itself is never serialised.

**Per-message ephemeral AES keys.** Each message uses a freshly generated AES-GCM-256 key. Compromising a single message key exposes only that message. Compromising the RSA private key allows decryption of all messages stored on the server (see limitation below), but does not affect messages that were never uploaded.

**XSS cannot steal private key bytes.** Because the private key CryptoKey is imported as `extractable: false`, calling `crypto.subtle.exportKey()` on it will throw a `DOMException`. An XSS payload can hold a reference to the CryptoKey object but cannot read the raw key material from it.

**Short token lifetime.** The 15-minute access token limits the window during which a stolen token can be misused. A stolen token expires before most users would notice the theft.

### Trade-offs made

**Wrapped private key on server.** To allow convenient login from the same browser after a page refresh, the AES-GCM-encrypted private key blob is stored on the WhisperBox server. A database breach exposes this blob. An attacker who also has the user's password (through a separate breach, phishing, or brute-force) could decrypt it. This is the standard cloud key-storage trade-off: convenience versus offline attack exposure. A purely local approach (key file, hardware token) would eliminate this risk but significantly worsen usability.

**Password is the weakest link.** The private key's security is bounded by the password used to wrap it. PBKDF2 slows brute-force attacks but cannot compensate for a short or predictable password. There is currently no client-side password entropy enforcement.

**`encryptedKeyForSelf` doubles key blob attack surface.** Every message payload contains two RSA-encrypted copies of the AES key — one for the recipient, one for the sender. This enables senders to read their own sent messages, but means there are twice as many ciphertext blobs an attacker could attempt to decrypt if they obtain a private key.

**Access token in IndexedDB.** The 15-minute access token is persisted so it survives page refreshes. A compromised browser extension, XSS payload, or physical access to the browser could retrieve it during that window. The short lifetime limits damage, but does not eliminate the risk.

**No certificate pinning.** The app trusts the browser's standard certificate chain for `whisperbox.koyeb.app`. A compromised certificate authority or DNS hijack could facilitate a man-in-the-middle attack, substituting a malicious public key. Key fingerprints are displayed in the chat header for manual verification, but this relies entirely on users actually checking them.

---

## Known Limitations

### Device-bound keys — no cross-device sync

Private keys are generated in the browser at registration and tied to that device. Logging into the same account on a second device will show the unlock modal, but entering the correct password there will fail — the encrypted key blob in that device's IndexedDB is empty. The blob on the server is retrievable, but the second device must re-derive and import it through a key export/import flow that has not been implemented.

Currently, the only way to use WhisperBox on a second device is to register a new account with a new key pair. All messages encrypted for the old public key will be unreadable on the new account.

### No forward secrecy at the RSA layer

Each message uses a fresh AES key (partial forward secrecy at the symmetric layer), but the RSA key pair is static and long-lived. If the RSA private key is ever compromised, an attacker who has recorded all past message payloads from the server can decrypt every AES key in every message and therefore every message ever sent to or from that account. True forward secrecy requires a ratcheting protocol like Signal's Double Ratchet, which rotates key material after every message exchange — not currently implemented.

### No key rotation or revocation

There is no mechanism to replace a compromised RSA key pair. Once a public key is registered, other users will continue encrypting messages with it until they search for and message a different account. A revocation list or key transparency log is not part of the current WhisperBox API.

### Memory cleared on page refresh

Because the private key is a non-extractable `CryptoKey` in JavaScript memory, every page refresh clears it. The unlock modal mitigates this by prompting for the password to re-derive and re-import the key, but every refresh requires user interaction. This is an unavoidable consequence of not storing the key in plaintext — security and convenience are directly in tension here.

### No message integrity beyond the AES-GCM auth tag

AES-GCM's authentication tag ensures that a tampered or corrupted ciphertext will fail to decrypt rather than producing garbage output. However, there is no higher-level signed message envelope. A server-side attacker could silently drop messages (preventing delivery), replay older messages, or reorder messages within a conversation — none of these would be detectable by the client cryptography as currently implemented.

### No group messaging

The encryption scheme wraps the AES key for exactly two parties (recipient and self). Supporting a group of N participants would require N RSA-encrypted key copies per message. The WhisperBox API currently only supports one-to-one conversations, so this is also an API limitation.

### WebSocket reconnection gap

When the access token nears expiry, the app closes the WebSocket, refreshes the token, and reconnects. During this reconnection window (typically under one second), incoming real-time messages are not received. The WhisperBox server buffers undelivered messages and flushes them on reconnect, so no messages are permanently lost — only real-time delivery is briefly interrupted.

### No offline message drafts

Messages cannot be composed and queued while the device is offline. The send flow requires an active HTTPS connection to `whisperbox.koyeb.app`. If the connection is unavailable, the send button will produce an error and the composed text must be re-sent manually after reconnection. No local draft persistence is implemented.

### No message deletion or editing

Once a message is sent and stored on the server, neither the sender nor the recipient can delete it or edit it through this client. The WhisperBox API does not expose a delete-message endpoint in the current version.

---
