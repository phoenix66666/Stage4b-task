/**
 * components/ChatWindow.js — Decrypts and displays a conversation
 *
 * Fetches message history from GET /conversations/{userId}/messages
 * Decrypts each message client-side using the in-memory private key.
 * Also accepts real-time messages pushed via WebSocket.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { decryptMessage, getKeyFingerprint, importPublicKeyBase64 } from '../utils/crypto';
import { getPrivateKey, getOwnPublicKey, getMessages } from '../utils/whisperbox';

function LockIcon({ size = 12, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({ msg, isSelf }) {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: isSelf ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
      {!isSelf && (
        <span style={{ fontSize: 10, color: '#4b5563', marginBottom: 4, marginLeft: 4, fontFamily: 'JetBrains Mono, monospace' }}>
          {msg.display_name || msg.senderUsername || 'unknown'}
        </span>
      )}
      <div style={{
        maxWidth: '72%', padding: '11px 15px',
        borderRadius: isSelf ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: isSelf ? 'linear-gradient(135deg,#0a1f1a,#0d2420)' : 'linear-gradient(135deg,#111827,#0f1929)',
        border: isSelf ? '1px solid rgba(0,212,170,0.2)' : '1px solid rgba(30,45,61,0.8)',
      }}>
        {msg._status === 'decrypting' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#4b5563' }}>
            <div style={{ width: 12, height: 12, border: '2px solid #1a2030', borderTop: '2px solid #00d4aa', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>Decrypting…</span>
          </div>
        )}
        {msg._status === 'error' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f87171', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Decryption failed
          </div>
        )}
        {msg._status === 'ok' && (
          <div style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {msg._plaintext}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, justifyContent: isSelf ? 'flex-end' : 'flex-start' }}>
          <LockIcon size={9} color="#4b5563" />
          <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>{formatTime(msg.created_at)}</span>
          {isSelf && msg._status === 'ok' && (
            <svg width={13} height={9} viewBox="0 0 24 16" fill="none" stroke="#00d4aa" strokeWidth="2.5">
              <polyline points="2 8 8 14 22 2"/>
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

async function decryptOne(msg, privateKey, currentUserId) {
  try {
    const plaintext = await decryptMessage(msg.payload, privateKey, currentUserId, msg.from_user_id);
    return { ...msg, _status: 'ok', _plaintext: plaintext };
  } catch {
    return { ...msg, _status: 'error', _plaintext: null };
  }
}

export default function ChatWindow({ recipient, currentUser, wsMessage, wsRef }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fingerprint, setFingerprint] = useState(null);
  const bottomRef = useRef(null);
  const seenIds = useRef(new Set());

  // Load key fingerprint
  useEffect(() => {
    if (!recipient?.public_key) { setFingerprint(null); return; }
    getKeyFingerprint(recipient.public_key).then(setFingerprint).catch(() => {});
  }, [recipient?.id]);

  // Fetch & decrypt history
  const fetchHistory = useCallback(async () => {
    if (!recipient || !currentUser) return;
    try {
      setLoading(true); setError(null);
      const raw = await getMessages(recipient.id, { limit: 50 });
      const privateKey = getPrivateKey();
      // Decrypt newest-first array, reverse for display
      const reversed = [...(raw || [])].reverse();
      const decrypted = await Promise.all(
        reversed.map((m) => {
          seenIds.current.add(m.id);
          return decryptOne(m, privateKey, currentUser.id);
        })
      );
      setMessages(decrypted);
    } catch (err) {
      if (err.status !== 401) setError('Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [recipient?.id, currentUser?.id]);

  useEffect(() => {
    setMessages([]);
    seenIds.current.clear();
    fetchHistory();
  }, [recipient?.id]);

  // Handle real-time WebSocket message
  useEffect(() => {
    if (!wsMessage || !recipient || !currentUser) return;
    // Only handle messages in current conversation
    const isRelevant =
      (wsMessage.from_user_id === recipient.id && wsMessage.to_user_id === currentUser.id) ||
      (wsMessage.from_user_id === currentUser.id && wsMessage.to_user_id === recipient.id);
    if (!isRelevant) return;
    if (seenIds.current.has(wsMessage.id)) return;
    seenIds.current.add(wsMessage.id);

    const privateKey = getPrivateKey();
    decryptOne(wsMessage, privateKey, currentUser.id).then((decrypted) => {
      setMessages((prev) => [...prev, decrypted]);
    });
  }, [wsMessage]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!recipient) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40 }}>
        <div style={{ color: '#1a2030' }}>
          <svg width={64} height={64} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#4b5563', fontWeight: 600, marginBottom: 6 }}>WhisperBox</div>
          <div style={{ color: '#374151', fontSize: 13 }}>Select a conversation or search for a user</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Header */}
      <div style={{ padding: '13px 20px', borderBottom: '1px solid #1a2030', background: '#0a0d14', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg,#00d4aa22,#00d4aa44)', border: '1px solid #00d4aa44', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#00d4aa', fontFamily: 'JetBrains Mono, monospace' }}>
          {(recipient.display_name || recipient.username || '?').slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 14 }}>{recipient.display_name || recipient.username}</div>
          {fingerprint && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
              <LockIcon size={9} color="#00d4aa" />
              <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>{fingerprint}</span>
            </div>
          )}
        </div>
        {/* E2EE badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 20, background: '#0a1f1a', border: '1px solid rgba(0,212,170,0.2)', color: '#00d4aa' }}>
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>
          </svg>
          <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>E2EE</span>
        </div>
        {/* WS indicator */}
        {wsRef?.current?.readyState === 1 && (
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#00d4aa' }} title="WebSocket connected" />
        )}
        <button onClick={fetchHistory} style={{ background: 'transparent', border: '1px solid #1a2030', borderRadius: 8, padding: '5px 7px', color: '#4b5563', cursor: 'pointer', transition: 'all 0.15s' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#00d4aa'; e.currentTarget.style.borderColor = '#00d4aa44'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#4b5563'; e.currentTarget.style.borderColor = '#1a2030'; }}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {loading && messages.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, height: '100%', color: '#4b5563' }}>
            <div style={{ width: 18, height: 18, border: '2px solid #1a2030', borderTop: '2px solid #00d4aa', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>Loading & decrypting…</span>
          </div>
        )}
        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: '#1a0d0d', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}
        {!loading && messages.length === 0 && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, textAlign: 'center' }}>
            <div className="lock-pulse" style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg,#0a1f1a,#0d2420)', border: '1px solid rgba(0,212,170,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00d4aa' }}>
              <LockIcon size={24} color="#00d4aa" />
            </div>
            <div>
              <div style={{ color: '#e2e8f0', fontWeight: 600, marginBottom: 6 }}>Encrypted channel ready</div>
              <div style={{ color: '#4b5563', fontSize: 13 }}>Messages are AES-256 encrypted in your browser.<br/>The server never sees plaintext.</div>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} isSelf={msg.from_user_id === currentUser?.id} />
        ))}
        <div ref={bottomRef} />
      </div>

      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
