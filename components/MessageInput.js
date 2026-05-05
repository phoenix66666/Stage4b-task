/**
 * components/MessageInput.js — Encrypts and sends messages
 *
 * Encryption flow:
 *  1. Fetch recipient's public key from server (or use cached)
 *  2. encryptMessage(text, recipientKey, ownKey) → payload
 *  3. Send via WebSocket (message.send) if connected
 *  4. Fall back to POST /messages if WS unavailable
 */
import { useState, useRef, useCallback } from 'react';
import { encryptMessage, importPublicKeyBase64 } from '../utils/crypto';
import {
  getPrivateKey, getOwnPublicKey, getUserPublicKey,
  wsSendMessage, sendMessage,
} from '../utils/whisperbox';

export default function MessageInput({ recipient, currentUser, wsRef, onMessageSent }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);
  // Cache recipient public key per session
  const recipientKeyCache = useRef({});

  const MAX = 2000;

  const handleChange = (e) => {
    if (e.target.value.length <= MAX) {
      setText(e.target.value);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !recipient) return;

    try {
      setSending(true); setError(null);

      // 1. Get recipient's public key (cache per id)
      let recipientPublicKey = recipientKeyCache.current[recipient.id];
      if (!recipientPublicKey) {
        // We need the base64 public key
        let base64Key = recipient.public_key;
        if (!base64Key) {
          const result = await getUserPublicKey(recipient.id);
          base64Key = result.public_key;
        }
        recipientPublicKey = await importPublicKeyBase64(base64Key);
        recipientKeyCache.current[recipient.id] = recipientPublicKey;
        // Store base64 on recipient object for future use
        recipient.public_key = base64Key;
      }

      // 2. Get own public key for encryptedKeyForSelf
      const ownBase64 = getOwnPublicKey();
      if (!ownBase64) throw new Error('Own public key not available');
      const ownPublicKey = await importPublicKeyBase64(ownBase64);

      // 3. Encrypt — plaintext never leaves client
      const payload = await encryptMessage(trimmed, recipientPublicKey, ownPublicKey);

      // 4. Send via WebSocket or REST fallback
      const ws = wsRef?.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSendMessage(ws, recipient.id, payload);
        // Optimistically add to UI
        onMessageSent?.({
          id: `local-${Date.now()}`,
          from_user_id: currentUser.id,
          to_user_id: recipient.id,
          payload,
          created_at: new Date().toISOString(),
          _status: 'ok',
          _plaintext: trimmed,
        });
      } else {
        // REST fallback
        const result = await sendMessage(recipient.id, payload);
        onMessageSent?.({
          ...result,
          _status: 'ok',
          _plaintext: trimmed,
        });
      }

      setText('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch (err) {
      console.error('[MessageInput]', err);
      if (err.message?.includes('public key')) setError("Cannot fetch recipient's public key");
      else if (err.status === 401) setError('Session expired — please log in again');
      else setError(err.message || 'Failed to send. Please try again.');
    } finally {
      setSending(false);
    }
  }, [text, sending, recipient, currentUser, wsRef, onMessageSent]);

  const disabled = !recipient || sending;

  return (
    <div style={{ padding: '14px 20px 18px', borderTop: '1px solid #1a2030', background: '#0a0d14' }}>
      {/* Encryption indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <div className="lock-pulse" style={{ color: '#00d4aa' }}>
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <span style={{ fontSize: 10, color: '#00d4aa', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em' }}>
          AES-256-GCM · RSA-OAEP · End-to-End Encrypted
        </span>
        {/* WS status */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          {wsRef?.current?.readyState === 1 ? (
            <>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00d4aa' }} />
              <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>live</span>
            </>
          ) : (
            <>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4b5563' }} />
              <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>rest</span>
            </>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="animate-fade-in" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: '#1a0d0d', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 12, marginBottom: 10 }}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* Input row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <div style={{
          flex: 1, position: 'relative', background: '#0e1117', borderRadius: 12,
          border: `1px solid ${!recipient ? '#1a2030' : text.length > 0 ? 'rgba(0,212,170,0.3)' : '#1a2030'}`,
          transition: 'border-color 0.2s',
          boxShadow: text.length > 0 ? '0 0 0 1px rgba(0,212,170,0.08)' : 'none',
        }}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={!recipient ? 'Select a contact to start chatting…' : sending ? 'Encrypting…' : `Message ${recipient.display_name || recipient.username} (Enter to send)`}
            rows={1}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: disabled ? '#4b5563' : '#e2e8f0', fontSize: 14, fontFamily: 'Sora, sans-serif', padding: '12px 16px', resize: 'none', lineHeight: 1.5, maxHeight: 120, minHeight: 44 }}
          />
          {text.length > 0 && (
            <div style={{ position: 'absolute', bottom: 7, right: 12, fontSize: 10, color: text.length > MAX * 0.9 ? '#f87171' : '#374151', fontFamily: 'JetBrains Mono, monospace' }}>
              {text.length}/{MAX}
            </div>
          )}
        </div>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!text.trim() || disabled}
          style={{
            width: 44, height: 44, borderRadius: 12, border: 'none', flexShrink: 0,
            background: !text.trim() || disabled ? '#111827' : 'linear-gradient(135deg,#00d4aa,#00b894)',
            color: !text.trim() || disabled ? '#4b5563' : '#000',
            cursor: !text.trim() || disabled ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s',
          }}
        >
          {sending ? (
            <div style={{ width: 16, height: 16, border: '2px solid rgba(0,0,0,0.2)', borderTop: '2px solid #000', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          ) : (
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          )}
        </button>
      </div>

      {recipient && (
        <div style={{ marginTop: 7, fontSize: 10, color: '#374151', fontFamily: 'JetBrains Mono, monospace', textAlign: 'right' }}>
          ↵ send · shift+↵ newline
        </div>
      )}
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        textarea::placeholder { color: #374151; }
      `}</style>
    </div>
  );
}
