/**
 * pages/login.js — Authentication page
 *
 * Registration flow (WhisperBox API):
 *  1. generateKeyPair()             — RSA-OAEP 2048 in browser
 *  2. generateSalt()                — 128-bit PBKDF2 salt
 *  3. deriveWrappingKey(pwd, salt)  — PBKDF2 → AES-KW
 *  4. wrapPrivateKey(priv, wrapKey) — AES-KW wrap → base64
 *  5. exportPublicKeyBase64(pub)    — SPKI → base64
 *  6. POST /auth/register           — public_key, wrapped_private_key, pbkdf2_salt
 *  7. unwrapPrivateKey()            — put in memory for immediate use
 *  8. saveSession()                 — tokens + key material in IndexedDB
 *
 * Login flow:
 *  1. POST /auth/login              — get tokens + wrapped_private_key + pbkdf2_salt
 *  2. deriveWrappingKey(pwd, salt)  — re-derive from password
 *  3. unwrapPrivateKey()            — put in memory
 *  4. saveSession()                 — tokens in IndexedDB
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import {
  generateKeyPair, generateSalt, deriveWrappingKey,
  wrapPrivateKey, unwrapPrivateKey, exportPublicKeyBase64,
} from '../utils/crypto';
import { saveSession } from '../utils/indexeddb';
import {
  register, login,
  setTokens, setPrivateKey, setOwnPublicKey,
} from '../utils/whisperbox';

function EyeIcon({ open }) {
  return open ? (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Username and password required'); return; }

    try {
      setLoading(true); setError(null);

      if (mode === 'register') {
        // ── Registration ─────────────────────────────────────────────────────
        setStep('Generating RSA-2048 key pair in browser…');
        const keyPair = await generateKeyPair();

        setStep('Generating PBKDF2 salt…');
        const pbkdf2_salt = generateSalt();

        setStep('Deriving AES-GCM wrapping key via PBKDF2…');
        const wrappingKey = await deriveWrappingKey(password, pbkdf2_salt);

        setStep('Encrypting private key with AES-256-GCM…');
        const wrapped_private_key = await wrapPrivateKey(keyPair.privateKey, wrappingKey);
        const public_key = await exportPublicKeyBase64(keyPair.publicKey);

        setStep('Registering with WhisperBox…');
        const data = await register({
          username: username.trim(),
          display_name: displayName.trim() || username.trim(),
          password,
          public_key,
          wrapped_private_key,
          pbkdf2_salt,
        });

        setStep('Setting up encrypted session…');
        // Put private key and own public key in memory
        setPrivateKey(keyPair.privateKey);
        setOwnPublicKey(data.user.public_key);
        setTokens(data.access_token, data.refresh_token);

        // Persist to IndexedDB (tokens + key blobs; private key stays in memory only)
        await saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });

        setStep('Done! Welcome to WhisperBox.');
        router.push('/');

      } else {
        // ── Login ────────────────────────────────────────────────────────────
        setStep('Authenticating…');
        const data = await login(username.trim(), password);

        setStep('Re-deriving AES-GCM wrapping key via PBKDF2…');
        const { wrapped_private_key, pbkdf2_salt, public_key } = data.user;
        const wrappingKey = await deriveWrappingKey(password, pbkdf2_salt);

        setStep('Decrypting private key into memory (AES-256-GCM)…');
        const privateKey = await unwrapPrivateKey(wrapped_private_key, wrappingKey);

        setStep('Saving session…');
        setPrivateKey(privateKey);
        setOwnPublicKey(public_key);
        setTokens(data.access_token, data.refresh_token);
        await saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });

        setStep('Redirecting…');
        router.push('/');
      }
    } catch (err) {
      console.error('[login]', err);
      if (err.status === 409) setError('Username already taken');
      else if (err.status === 401) setError('Invalid username or password');
      else if (err.status === 422) setError(err.data?.detail?.[0]?.msg || 'Validation error');
      else setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false); setStep(null);
    }
  };

  return (
    <>
      <Head>
        <title>WhisperBox — Secure E2EE Messaging</title>
      </Head>
      <div className="grid-bg" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, position: 'relative', overflow: 'hidden' }}>
        {/* Background glow */}
        <div style={{ position: 'absolute', top: '30%', left: '50%', transform: 'translate(-50%,-50%)', width: 600, height: 400, background: 'radial-gradient(ellipse,rgba(0,212,170,0.06) 0%,transparent 70%)', pointerEvents: 'none' }} />

        <div className="animate-slide-up" style={{ width: '100%', maxWidth: 420, position: 'relative' }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div className="lock-pulse" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 68, height: 68, borderRadius: 18, background: 'linear-gradient(135deg,#0a1f1a,#0d2420)', border: '1px solid rgba(0,212,170,0.3)', marginBottom: 14, color: '#00d4aa' }}>
              <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <h1 style={{ fontFamily: 'Sora, sans-serif', fontSize: 26, fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.02em', marginBottom: 6 }}>
              Whisper<span style={{ color: '#00d4aa' }}>Box</span>
            </h1>
            <p style={{ fontSize: 12, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>
              RSA-2048 · AES-256-GCM · PBKDF2 · Zero-Knowledge
            </p>
          </div>

          {/* Card */}
          <div style={{ background: '#0e1117', border: '1px solid #1a2030', borderRadius: 20, padding: 26 }}>
            {/* Mode tabs */}
            <div style={{ display: 'flex', background: '#080a0f', borderRadius: 10, padding: 3, marginBottom: 22, border: '1px solid #1a2030' }}>
              {['login', 'register'].map((m) => (
                <button key={m} onClick={() => { setMode(m); setError(null); }}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: mode === m ? '1px solid rgba(0,212,170,0.2)' : 'none', background: mode === m ? 'linear-gradient(135deg,#0a1f1a,#0d2420)' : 'transparent', color: mode === m ? '#00d4aa' : '#4b5563', fontFamily: 'Sora, sans-serif', fontSize: 13, fontWeight: mode === m ? 600 : 400, cursor: 'pointer', transition: 'all 0.2s' }}>
                  {m === 'login' ? 'Sign In' : 'Register'}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit}>
              {/* Username */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 10, color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace', marginBottom: 7, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Username</label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="secure-input" placeholder="alice_92" autoComplete="username" required disabled={loading}
                  style={{ width: '100%', background: '#080a0f', border: '1px solid #1a2030', borderRadius: 9, padding: '11px 13px', color: '#e2e8f0', fontSize: 14, fontFamily: 'JetBrains Mono, monospace' }} />
                {mode === 'register' && <p style={{ fontSize: 10, color: '#374151', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>3–32 chars · letters/digits/_/-</p>}
              </div>

              {/* Display name (register only) */}
              {mode === 'register' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: 10, color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace', marginBottom: 7, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Display Name <span style={{ color: '#374151' }}>(optional)</span></label>
                  <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="secure-input" placeholder="Alice" disabled={loading}
                    style={{ width: '100%', background: '#080a0f', border: '1px solid #1a2030', borderRadius: 9, padding: '11px 13px', color: '#e2e8f0', fontSize: 14, fontFamily: 'JetBrains Mono, monospace' }} />
                </div>
              )}

              {/* Password */}
              <div style={{ marginBottom: 22 }}>
                <label style={{ display: 'block', fontSize: 10, color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace', marginBottom: 7, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} className="secure-input" placeholder="••••••••" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required disabled={loading}
                    style={{ width: '100%', background: '#080a0f', border: '1px solid #1a2030', borderRadius: 9, padding: '11px 40px 11px 13px', color: '#e2e8f0', fontSize: 14, fontFamily: 'JetBrains Mono, monospace' }} />
                  <button type="button" onClick={() => setShowPwd(!showPwd)} style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}>
                    <EyeIcon open={showPwd} />
                  </button>
                </div>
                {mode === 'register' && <p style={{ fontSize: 10, color: '#374151', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>8–128 chars · used to wrap your private key via PBKDF2</p>}
              </div>

              {/* Progress */}
              {step && (
                <div className="animate-fade-in" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 9, background: '#0a1f1a', border: '1px solid rgba(0,212,170,0.2)', marginBottom: 14 }}>
                  <div style={{ width: 13, height: 13, border: '2px solid rgba(0,212,170,0.3)', borderTop: '2px solid #00d4aa', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: '#00d4aa', fontFamily: 'JetBrains Mono, monospace' }}>{step}</span>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="animate-fade-in" style={{ display: 'flex', gap: 10, padding: '10px 13px', borderRadius: 9, background: '#1a0d0d', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}>
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  {error}
                </div>
              )}

              {/* Submit */}
              <button type="submit" disabled={loading} style={{ width: '100%', padding: 12, borderRadius: 11, border: 'none', background: loading ? '#111827' : 'linear-gradient(135deg,#00d4aa,#00b894)', color: loading ? '#4b5563' : '#000', fontFamily: 'Sora, sans-serif', fontSize: 14, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 0.2s' }}>
                {loading ? (
                  <><div style={{ width: 15, height: 15, border: '2px solid rgba(0,0,0,0.2)', borderTop: '2px solid #4b5563', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />Processing…</>
                ) : mode === 'login' ? (
                  <><svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Sign In Securely</>
                ) : (
                  <><svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Create Encrypted Account</>
                )}
              </button>
            </form>
          </div>

          {/* Info */}
          <div style={{ marginTop: 18, padding: '13px 16px', borderRadius: 11, background: 'rgba(0,212,170,0.04)', border: '1px solid rgba(0,212,170,0.1)' }}>
            <p style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.6 }}>
              {mode === 'register' ? (
                <><span style={{ color: '#00d4aa', fontWeight: 600 }}>On register:</span> RSA-2048 keypair generated in browser via Web Crypto API. Private key encrypted with PBKDF2+AES-256-GCM using your password. Only the encrypted blob goes to the server — your plaintext private key never leaves this device. JWTs are issued by the server and stored in IndexedDB (never localStorage).</>
              ) : (
                <><span style={{ color: '#00d4aa', fontWeight: 600 }}>Zero-knowledge:</span> WhisperBox cannot read your messages. The server stores only ciphertext. Your password unwraps your private key locally — the server never sees it.</>
              )}
            </p>
          </div>
        </div>
        <style jsx>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          input::placeholder { color: #374151; }
        `}</style>
      </div>
    </>
  );
}
