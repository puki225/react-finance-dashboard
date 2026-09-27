import React, { useState, useRef, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'gb_chat_conversation_id';

// Assistant messages (and the leading turn of a tool round-trip) are stored as an array of
// content blocks (text/tool_use); a plain user message is stored as a bare string. Tool
// results live in their own 'user'-role turn as an array of tool_result blocks - nothing in
// either of those belongs in the transcript the person actually reads, so a turn with no
// text block in it is skipped entirely rather than rendered as an empty bubble.
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return text || null;
  }
  return null;
}

function ChatIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M4 4h16v12H8l-4 4V4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // [{ role, text }]
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState(null);
  const [conversationId, setConversationId] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? parseInt(stored, 10) : null;
  });
  const listRef = useRef(null);
  const loadedHistoryFor = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  // Load prior turns for a remembered conversation the first time the panel opens, not on
  // every app load - most visits never open the widget at all.
  useEffect(() => {
    if (!open || !conversationId || loadedHistoryFor.current === conversationId) return;
    loadedHistoryFor.current = conversationId;
    setLoadingHistory(true);
    fetch(`/api/chat/conversations/${conversationId}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'not_found' : `Request failed: ${r.status}`)))
      .then(d => {
        const rows = (d.messages || [])
          .map(m => ({ role: m.role, text: extractText(m.content) }))
          .filter(m => m.text);
        setMessages(rows);
      })
      .catch(() => {
        // A conversation ID that no longer resolves (DB reset, etc.) shouldn't wedge the
        // widget - just start fresh silently.
        localStorage.removeItem(STORAGE_KEY);
        setConversationId(null);
      })
      .finally(() => setLoadingHistory(false));
  }, [open, conversationId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError(null);
    setMessages(prev => [...prev, { role: 'user', text }]);
    setSending(true);
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, message: text }),
      });
      if (resp.status === 404) { setUnavailable(true); setSending(false); return; }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `Request failed: ${resp.status}`);
      if (data.conversation_id && data.conversation_id !== conversationId) {
        setConversationId(data.conversation_id);
        localStorage.setItem(STORAGE_KEY, String(data.conversation_id));
      }
      setMessages(prev => [...prev, { role: 'assistant', text: data.reply || '(no reply)' }]);
    } catch (e) {
      setError(e.message);
    }
    setSending(false);
  }, [input, sending, conversationId]);

  const startNewConversation = () => {
    setConversationId(null);
    localStorage.removeItem(STORAGE_KEY);
    loadedHistoryFor.current = null;
    setMessages([]);
    setError(null);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        title={open ? 'Close assistant' : 'Ask the assistant'}
        style={{
          position: 'fixed', bottom: 24, right: 24, width: 56, height: 56, borderRadius: '50%',
          background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 16px #00000060', zIndex: 1001, transition: 'transform 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.06)')}
        onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {open && (
        <div style={{
          position: 'fixed', bottom: 92, right: 24, width: 360, maxWidth: 'calc(100vw - 32px)',
          height: 520, maxHeight: 'calc(100vh - 140px)', background: 'var(--bg2)',
          border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 12px 40px #00000070',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 1001,
        }}>
          <div style={{
            padding: '14px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Assistant</div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>Ask about sales, margin, cash flow, inventory</div>
            </div>
            {messages.length > 0 && (
              <button onClick={startNewConversation} title="Start a new conversation" style={{
                background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--muted)',
                fontSize: 11, padding: '4px 8px', cursor: 'pointer', fontFamily: 'var(--font)',
              }}>New chat</button>
            )}
          </div>

          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {unavailable && (
              <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, textAlign: 'center', margin: 'auto' }}>
                The assistant isn't set up yet — an ANTHROPIC_API_KEY needs to be added to the server's environment.
              </div>
            )}
            {!unavailable && loadingHistory && (
              <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', margin: 'auto' }}>Loading…</div>
            )}
            {!unavailable && !loadingHistory && messages.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, textAlign: 'center', margin: 'auto' }}>
                Ask something like "what was my Amazon margin last month" or "when does SKU X need reordering".
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%', padding: '8px 12px', borderRadius: 12,
                background: m.role === 'user' ? 'var(--accent)' : 'var(--bg3)',
                color: m.role === 'user' ? '#fff' : 'var(--text)',
                fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {m.text}
              </div>
            ))}
            {sending && (
              <div style={{ alignSelf: 'flex-start', padding: '8px 12px', borderRadius: 12, background: 'var(--bg3)', color: 'var(--muted)', fontSize: 13 }}>
                …
              </div>
            )}
            {error && (
              <div style={{ alignSelf: 'flex-start', color: 'var(--red)', fontSize: 11, padding: '0 4px' }}>{error}</div>
            )}
          </div>

          <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question…"
              disabled={unavailable || sending}
              rows={1}
              style={{
                flex: 1, resize: 'none', background: 'var(--bg3)', border: '1px solid var(--border2)',
                borderRadius: 8, color: 'var(--text)', fontFamily: 'var(--font)', fontSize: 13,
                padding: '8px 10px', outline: 'none', maxHeight: 80,
              }}
            />
            <button
              onClick={send}
              disabled={unavailable || sending || !input.trim()}
              style={{
                width: 36, height: 36, borderRadius: 8, border: 'none', flexShrink: 0,
                background: (unavailable || sending || !input.trim()) ? 'var(--bg3)' : 'var(--accent)',
                color: (unavailable || sending || !input.trim()) ? 'var(--muted)' : '#fff',
                cursor: (unavailable || sending || !input.trim()) ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
