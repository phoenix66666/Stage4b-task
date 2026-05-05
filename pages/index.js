/**
 * pages/index.js — Main chat page
 *
 * On mount:
 *  1. Restore session from IndexedDB
 *  2. Check token expiry — refresh if needed
 *  3. Re-unwrap private key (requires password if page was refreshed)
 *     → For simplicity: if private key not in memory, redirect to login
 *  4. Open WebSocket connection to wss://whisperbox.koyeb.app/ws
 *  5. Handle incoming message.receive / user.online / user.offline events
 *  6. Auto-refresh access token before expiry
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import UserList from '../components/UserList';
import ChatWindow from '../components/ChatWindow';
import MessageInput from '../components/MessageInput';
import { getSession, clearStoredSession, saveSession } from '../utils/indexeddb';
import {
  setTokens, setPrivateKey, setOwnPublicKey,
  getPrivateKey, getAccessToken, getRefreshToken,
  connectWebSocket, logout as apiLogout, refreshToken,
} from '../utils/whisperbox';
import { isTokenExpired, isTokenExpiringSoon, secondsUntilExpiry } from '../utils/jwt';
import { deriveWrappingKey, unwrapPrivateKey } from '../utils/crypto';

// ─── Unlock modal (shown if private key not in memory after page refresh) ─────

function UnlockModal({ user, onUnlock, onLogout }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleUnlock = async (e) => {
    e.preventDefault();
    if (!password) return;
    try {
      setLoading(true); setError(null);
      const wrappingKey = await deriveWrappingKey(password, user.pbkdf2_salt);
      const privateKey = await unwrapPrivateKey(user.wrapped_private_key, wrappingKey);
      setPrivateKey(privateKey);
      setOwnPublicKey(user.public_key);
      onUnlock();
    } catch {
      setError('Wrong password — could not unwrap private key');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#080a0f', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div className="animate-slide-up" style={{ width: '100%', maxWidth: 380, padding: 20 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div className="lock-pulse" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 60, height: 60, borderRadius: 16, background: 'linear-gradient(135deg,#0a1f1a,#0d2420)', border: '1px solid rgba(0,212,170,0.3)', color: '#00d4aa', marginBottom: 14 }}>
            <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <h2 style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 20, marginBottom: 8 }}>Unlock Session</h2>
          <p style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.6 }}>
            Enter your password to decrypt your private key.<br/>
            <span style={{ color: '#374151', fontSize: 11 }}>Your key was encrypted with PBKDF2+AES-256-GCM — only your password can unlock it.</span>
          </p>
        </div>
        <div style={{ background: '#0e1117', border: '1px solid #1a2030', borderRadius: 16, padding: 22 }}>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>Logged in as <span style={{ color: '#00d4aa' }}>{user.username}</span></div>
          <form onSubmit={handleUnlock}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoFocus required
              className="secure-input"
              style={{ width: '100%', background: '#080a0f', border: '1px solid #1a2030', borderRadius: 9, padding: '11px 13px', color: '#e2e8f0', fontSize: 14, fontFamily: 'JetBrains Mono, monospace', marginBottom: 12 }} />
            {error && (
              <div style={{ padding: '8px 12px', borderRadius: 8, background: '#1a0d0d', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 12, marginBottom: 12 }}>{error}</div>
            )}
            <button type="submit" disabled={loading} style={{ width: '100%', padding: 11, borderRadius: 10, border: 'none', background: loading ? '#111827' : 'linear-gradient(135deg,#00d4aa,#00b894)', color: loading ? '#4b5563' : '#000', fontFamily: 'Sora, sans-serif', fontSize: 14, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', marginBottom: 10 }}>
              {loading ? 'Unlocking…' : 'Unlock'}
            </button>
            <button type="button" onClick={onLogout} style={{ width: '100%', padding: 9, borderRadius: 10, border: '1px solid #1a2030', background: 'transparent', color: '#4b5563', fontFamily: 'Sora, sans-serif', fontSize: 13, cursor: 'pointer' }}>
              Sign out instead
            </button>
          </form>
        </div>
      </div>
      <style jsx>{`input::placeholder { color: #374151; }`}</style>
    </div>
  );
}

// ─── Logout modal ────────────────────────────────────────────────────────────

function LogoutModal({ onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, backdropFilter: 'blur(4px)' }}>
      <div className="animate-slide-up" style={{ background: '#0e1117', border: '1px solid #1a2030', borderRadius: 16, padding: 26, maxWidth: 360, width: '90%' }}>
        <h3 style={{ color: '#e2e8f0', fontWeight: 700, marginBottom: 8 }}>Sign Out</h3>
        <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>Your refresh token will be revoked. Private key stays wrapped in IndexedDB — next login will ask for your password to unlock it.</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: 10, borderRadius: 9, border: '1px solid #1a2030', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontFamily: 'Sora, sans-serif', fontSize: 14 }}>Cancel</button>
          <button onClick={onConfirm} style={{ flex: 1, padding: 10, borderRadius: 9, border: 'none', background: 'linear-gradient(135deg,#7f1d1d,#991b1b)', color: '#fca5a5', cursor: 'pointer', fontFamily: 'Sora, sans-serif', fontSize: 14, fontWeight: 600 }}>Sign Out</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [storedSession, setStoredSession] = useState(null);
  const [showLogout, setShowLogout] = useState(false);
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connected'|'disconnected'|'error'
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [lastWsMessage, setLastWsMessage] = useState(null);
  const [sentMessage, setSentMessage] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const tokenRefreshTimer = useRef(null);

  // ── WebSocket ──────────────────────────────────────────────────────────────

  const connectWS = useCallback(() => {
    if (!getAccessToken()) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = connectWebSocket({
        onOpen: () => setWsStatus('connected'),
        onClose: () => {
          setWsStatus('disconnected');
          // Reconnect after 3s
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = setTimeout(connectWS, 3000);
        },
        onError: () => setWsStatus('error'),
        onMessage: (frame) => setLastWsMessage({ ...frame, _ts: Date.now() }),
        onOnline: (userId) => setOnlineUsers((s) => new Set([...s, userId])),
        onOffline: (userId) => setOnlineUsers((s) => { const n = new Set(s); n.delete(userId); return n; }),
      });
      wsRef.current = ws;
    } catch {
      setWsStatus('error');
    }
  }, []);

  // ── Token auto-refresh ─────────────────────────────────────────────────────

  const scheduleTokenRefresh = useCallback((accessToken) => {
    clearTimeout(tokenRefreshTimer.current);
    const secs = secondsUntilExpiry(accessToken);
    if (secs <= 0) return;
    // Refresh 90s before expiry
    const delay = Math.max((secs - 90) * 1000, 5000);
    tokenRefreshTimer.current = setTimeout(async () => {
      const newToken = await refreshToken();
      if (newToken) {
        await saveSession({ access_token: newToken, refresh_token: getRefreshToken(), user: storedSession });
        scheduleTokenRefresh(newToken);
        // Reconnect WS with new token
        wsRef.current?.close();
        setTimeout(connectWS, 500);
      }
    }, delay);
  }, [connectWS, storedSession]);

  // ── Session restore ────────────────────────────────────────────────────────

  useEffect(() => {
    async function restore() {
      try {
        const session = await getSession();
        if (!session) { router.replace('/login'); return; }

        // Check token
        if (isTokenExpired(session.access_token)) {
          // Try refresh
          setTokens(session.access_token, session.refresh_token);
          const newToken = await refreshToken();
          if (!newToken) { await clearStoredSession(); router.replace('/login'); return; }
          session.access_token = newToken;
          await saveSession({ access_token: newToken, refresh_token: session.refresh_token, user: session });
        }

        setTokens(session.access_token, session.refresh_token);
        setCurrentUser({ id: session.user_id, username: session.username, display_name: session.display_name });
        setStoredSession(session);

        // Check if private key is in memory
        if (!getPrivateKey()) {
          // Need password to unwrap
          setNeedsUnlock(true);
        } else {
          setOwnPublicKey(session.public_key);
          connectWS();
          scheduleTokenRefresh(session.access_token);
        }
      } catch (err) {
        console.error('[index] restore failed', err);
        router.replace('/login');
      } finally {
        setLoading(false);
      }
    }
    restore();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearTimeout(tokenRefreshTimer.current);
      wsRef.current?.close();
    };
  }, []);

  const handleUnlock = () => {
    setNeedsUnlock(false);
    connectWS();
    if (storedSession) scheduleTokenRefresh(storedSession.access_token);
  };

  const handleLogout = async () => {
    clearTimeout(reconnectTimer.current);
    clearTimeout(tokenRefreshTimer.current);
    wsRef.current?.close();
    await apiLogout();
    await clearStoredSession();
    router.push('/login');
  };

  const handleSentMessage = (msg) => {
    setSentMessage({ ...msg, _ts: Date.now() });
  };

  const handleSelectUser = (user) => {
    setSelectedUser(user);
    setSentMessage(null);
    setLastWsMessage(null);
  };

  // Loading
  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#080a0f' }}>
        <div className="lock-pulse" style={{ color: '#00d4aa' }}>
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div style={{ width: 28, height: 28, border: '2px solid #1a2030', borderTop: '2px solid #00d4aa', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <span style={{ color: '#4b5563', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>Restoring encrypted session…</span>
        <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (needsUnlock && storedSession) {
    return <UnlockModal user={storedSession} onUnlock={handleUnlock} onLogout={handleLogout} />;
  }

  return (
    <>
      <Head><title>WhisperBox — Secure Messaging</title></Head>

      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#080a0f', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', height: 58, borderBottom: '1px solid #1a2030', background: '#080a0f', flexShrink: 0 }}>
          <div className="lock-pulse" style={{ color: '#00d4aa' }}>
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <span style={{ fontFamily: 'Sora, sans-serif', fontWeight: 700, fontSize: 16, color: '#e2e8f0', letterSpacing: '-0.02em' }}>
            Whisper<span style={{ color: '#00d4aa' }}>Box</span>
          </span>

          {/* E2EE badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20, background: '#0a1f1a', border: '1px solid rgba(0,212,170,0.2)' }}>
            <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="#00d4aa" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>
            </svg>
            <span style={{ fontSize: 10, color: '#00d4aa', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>END-TO-END ENCRYPTED</span>
          </div>

          {/* WS status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }} title={`WebSocket: ${wsStatus}`}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: wsStatus === 'connected' ? '#00d4aa' : wsStatus === 'error' ? '#f87171' : '#4b5563', transition: 'background 0.3s' }} />
            <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>
              {wsStatus === 'connected' ? 'live' : wsStatus === 'error' ? 'err' : 'off'}
            </span>
          </div>

          <div style={{ flex: 1 }} />

          {currentUser && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace' }}>{currentUser.display_name || currentUser.username}</span>
              <button onClick={() => setShowLogout(true)} style={{ padding: '5px 11px', borderRadius: 8, border: '1px solid #1a2030', background: 'transparent', color: '#4b5563', fontSize: 12, cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#4b5563'; e.currentTarget.style.borderColor = '#1a2030'; }}>
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <UserList
            currentUser={currentUser}
            selectedUser={selectedUser}
            onSelectUser={handleSelectUser}
            onlineUsers={onlineUsers}
          />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#080a0f' }}>
            <ChatWindow
              recipient={selectedUser}
              currentUser={currentUser}
              wsMessage={lastWsMessage}
              wsRef={wsRef}
            />
            <MessageInput
              recipient={selectedUser}
              currentUser={currentUser}
              wsRef={wsRef}
              onMessageSent={handleSentMessage}
            />
          </div>
        </div>
      </div>

      {showLogout && <LogoutModal onConfirm={handleLogout} onCancel={() => setShowLogout(false)} />}

      <style jsx global>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
