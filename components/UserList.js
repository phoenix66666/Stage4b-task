/**
 * components/UserList.js — Conversations sidebar with user search
 *
 * Shows:
 *  1. Existing conversations (GET /conversations)
 *  2. Search results (GET /users/search?q=)
 */
import { useEffect, useState, useCallback } from 'react';
import { getConversations, searchUsers } from '../utils/whisperbox';

function LockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function Avatar({ name = '?', size = 36, online }) {
  const palette = ['#00d4aa','#22d3ee','#a78bfa','#f59e0b','#34d399','#fb7185','#60a5fa','#f97316'];
  const color = palette[(name.charCodeAt(0) || 0) % palette.length];
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: 10, flexShrink: 0,
        background: `linear-gradient(135deg,${color}22,${color}44)`,
        border: `1px solid ${color}44`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.38, fontWeight: 700, color,
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        {name.slice(0, 2).toUpperCase()}
      </div>
      {online && (
        <div style={{
          position: 'absolute', bottom: -1, right: -1,
          width: 10, height: 10, borderRadius: '50%',
          background: '#00d4aa', border: '2px solid #0a0d14',
        }} />
      )}
    </div>
  );
}

export default function UserList({ currentUser, selectedUser, onSelectUser, onlineUsers = new Set() }) {
  const [conversations, setConversations] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load conversations
  const fetchConversations = useCallback(async () => {
    try {
      setError(null);
      const list = await getConversations();
      setConversations(list || []);
    } catch (err) {
      if (err.status !== 401) setError('Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 15000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  // Search users
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        setSearching(true);
        const results = await searchUsers(searchQuery.trim());
        setSearchResults(results || []);
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const items = isSearching ? searchResults : conversations;

  return (
    <div style={{ width: 280, flexShrink: 0, background: '#0a0d14', borderRight: '1px solid #1a2030', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #1a2030' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div className="lock-pulse" style={{ color: '#00d4aa' }}><LockIcon size={15} /></div>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 600, color: '#00d4aa', letterSpacing: '0.1em', textTransform: 'uppercase' }}>WhisperBox</span>
        </div>

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#4b5563' }} width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search users..."
            className="secure-input"
            style={{ width: '100%', background: '#0e1117', border: '1px solid #1a2030', borderRadius: 8, padding: '8px 10px 8px 32px', color: '#e2e8f0', fontSize: 13, fontFamily: 'Sora, sans-serif' }}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
          )}
        </div>
      </div>

      {/* Current user */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1a2030', background: '#0d1018' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={currentUser?.username || 'me'} size={30} online />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentUser?.display_name || currentUser?.username}
            </div>
            <div style={{ fontSize: 10, color: '#00d4aa', fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <polyline points="9 12 11 14 15 10"/>
              </svg>
              E2EE Active
            </div>
          </div>
        </div>
      </div>

      {/* Section label */}
      <div style={{ padding: '10px 14px 6px', fontSize: 10, color: '#374151', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        {isSearching ? (searching ? 'Searching…' : `${searchResults.length} found`) : 'Conversations'}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
        {loading && !isSearching && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <div style={{ width: 20, height: 20, border: '2px solid #1a2030', borderTop: '2px solid #00d4aa', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        )}
        {error && (
          <div style={{ margin: 8, padding: '10px 12px', borderRadius: 8, background: '#1a0d0d', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 12 }}>{error}</div>
        )}
        {!loading && !isSearching && conversations.length === 0 && !error && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#4b5563', fontSize: 13 }}>
            No conversations yet<br/>
            <span style={{ fontSize: 11, color: '#374151' }}>Search for users above</span>
          </div>
        )}
        {isSearching && searchResults.length === 0 && !searching && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#4b5563', fontSize: 13 }}>No users found</div>
        )}

        {items.map((item) => {
          // item can be a conversation or a search result
          const userId = item.user_id || item.id;
          const username = item.username;
          const displayName = item.display_name || username;
          const isSelected = selectedUser?.id === userId;
          const isOnline = onlineUsers.has(userId);

          return (
            <button
              key={userId}
              onClick={() => onSelectUser({ id: userId, username, display_name: displayName })}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 10px', borderRadius: 10, marginBottom: 2, textAlign: 'left', cursor: 'pointer',
                border: isSelected ? '1px solid rgba(0,212,170,0.3)' : '1px solid transparent',
                background: isSelected ? 'linear-gradient(135deg,#0a1f1a,#0d2420)' : 'transparent',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#111827'; }}
              onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
            >
              <Avatar name={username} size={34} online={isOnline} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: isSelected ? 600 : 500, color: isSelected ? '#00d4aa' : '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <LockIcon size={9} />
                  <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>
                    {isOnline ? 'online' : 'encrypted'}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Refresh */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid #1a2030' }}>
        <button
          onClick={fetchConversations}
          style={{ width: '100%', padding: 7, borderRadius: 8, border: '1px solid #1a2030', background: 'transparent', color: '#4b5563', fontSize: 11, cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'all 0.15s' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#00d4aa'; e.currentTarget.style.borderColor = '#00d4aa44'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#4b5563'; e.currentTarget.style.borderColor = '#1a2030'; }}
        >
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Refresh
        </button>
      </div>
      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
