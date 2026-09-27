import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import ChatChart from './ChatChart';

const STORAGE_KEY = 'gb_chat_conversation_id';

// Allows only <details>/<summary> on top of the default safe Markdown element set, so the
// assistant can collapse supporting detail out of the way (per its system prompt) without
// opening up arbitrary raw HTML from model output - see the sanitize schema's "why" in
// chat.js's system prompt comment for the paired half of this.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames, 'details', 'summary'],
  attributes: { ...defaultSchema.attributes, details: ['open'] },
};

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

// Fenced ```chart blocks (see chat.js's system prompt for the JSON schema) render as an
// inline chart instead of a code block; every other fenced/inline code renders normally.
// `pre` is overridden too, not just `code` - otherwise the chart would still end up nested
// inside a <pre>, inheriting its monospace/white-space styling.
const markdownComponents = {
  code(props) {
    const { className, children } = props;
    const match = /language-(\w+)/.exec(className || '');
    if (match && match[1] === 'chart') {
      return <ChatChart raw={String(children).replace(/\n$/, '')} />;
    }
    return <code className={className}>{children}</code>;
  },
  pre(props) {
    const child = props.children;
    const isChart = child && child.props && /language-chart/.test(child.props.className || '');
    if (isChart) return <>{child}</>;
    return <pre>{props.children}</pre>;
  },
};

function MessageBubble({ role, text }) {
  if (role === 'user') {
    return (
      <div style={{
        alignSelf: 'flex-end', maxWidth: '85%', padding: '8px 12px', borderRadius: 12,
        background: 'var(--accent)', color: '#fff', fontSize: 13, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {text}
      </div>
    );
  }
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', padding: '8px 12px', borderRadius: 12, background: 'var(--bg3)' }}>
      <div className="chat-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
          components={markdownComponents}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
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

function MaximizeIcon({ maximized }) {
  return maximized ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M9 3H3v6M15 21h6v-6M3 3l7 7M21 21l-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M3 9V3h6M21 15v6h-6M3 3l7 7M21 21l-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M3 12a9 9 0 1 0 3-6.7M3 12V5m0 7h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8v4l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Short, friendly relative timestamp for the conversation list - "just now" through a
// plain date once it's more than a week old, rather than a raw ISO string.
function formatRelative(iso) {
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [view, setView] = useState('chat'); // 'chat' | 'history'
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
  const [conversations, setConversations] = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const listRef = useRef(null);
  const loadedHistoryFor = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open, maximized]);

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
    setView('chat');
  };

  // Backend already returns them newest-first (ORDER BY updated_at DESC) - the active
  // conversation's own most recent message bumps it back to the top next time this loads.
  const openHistory = () => {
    setView('history');
    setLoadingConversations(true);
    fetch('/api/chat/conversations')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Request failed: ${r.status}`)))
      .then(setConversations)
      .catch(() => setConversations([]))
      .finally(() => setLoadingConversations(false));
  };

  const loadConversation = (id) => {
    if (id !== conversationId) {
      loadedHistoryFor.current = null;
      setMessages([]);
      setConversationId(id);
      localStorage.setItem(STORAGE_KEY, String(id));
    }
    setView('chat');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const panelStyle = maximized
    ? {
      position: 'fixed', bottom: 24, right: 24, top: 24, left: 24,
      width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none',
    }
    : {
      position: 'fixed', bottom: 92, right: 24, width: 380, maxWidth: 'calc(100vw - 32px)',
      height: 560, maxHeight: 'calc(100vh - 140px)',
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
          ...panelStyle, background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 16,
          boxShadow: '0 12px 40px #00000070', display: 'flex', flexDirection: 'column',
          overflow: 'hidden', zIndex: 1001, transition: 'width 0.15s, height 0.15s',
        }}>
          <div style={{
            padding: '14px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
          }}>
            <div>
              {view === 'history' ? (
                <div style={{ fontSize: 13, fontWeight: 700 }}>Previous chats</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Assistant</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>Ask about sales, margin, cash flow, inventory</div>
                </>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {view === 'history' ? (
                <button onClick={() => setView('chat')} title="Back to chat" style={{
                  background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--muted)',
                  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
                }}>
                  <BackIcon />
                </button>
              ) : (
                <>
                  <button onClick={openHistory} title="Previous chats" style={{
                    background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--muted)',
                    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
                  }}>
                    <HistoryIcon />
                  </button>
                  {messages.length > 0 && (
                    <button onClick={startNewConversation} title="Start a new conversation" style={{
                      background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--muted)',
                      fontSize: 11, padding: '4px 8px', cursor: 'pointer', fontFamily: 'var(--font)',
                    }}>New chat</button>
                  )}
                  <button onClick={() => setMaximized(m => !m)} title={maximized ? 'Restore' : 'Maximize'} style={{
                    background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--muted)',
                    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
                  }}>
                    <MaximizeIcon maximized={maximized} />
                  </button>
                </>
              )}
            </div>
          </div>

          {view === 'history' ? (
            <div style={{
              flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 4,
              maxWidth: maximized ? 720 : 'none', width: '100%', margin: maximized ? '0 auto' : 0,
            }}>
              {loadingConversations && (
                <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', margin: 'auto' }}>Loading…</div>
              )}
              {!loadingConversations && conversations.length === 0 && (
                <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', margin: 'auto' }}>No previous chats yet.</div>
              )}
              {conversations.map(c => (
                <button key={c.id} onClick={() => loadConversation(c.id)} style={{
                  textAlign: 'left', background: c.id === conversationId ? 'var(--bg3)' : 'none',
                  border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
                  cursor: 'pointer', fontFamily: 'var(--font)', color: 'var(--text)',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title || 'Untitled chat'}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{formatRelative(c.updated_at)}</span>
                </button>
              ))}
            </div>
          ) : (
          <div ref={listRef} style={{
            flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
            maxWidth: maximized ? 720 : 'none', width: '100%', margin: maximized ? '0 auto' : 0,
          }}>
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
            {messages.map((m, i) => <MessageBubble key={i} role={m.role} text={m.text} />)}
            {sending && (
              <div style={{ alignSelf: 'flex-start', padding: '8px 12px', borderRadius: 12, background: 'var(--bg3)', color: 'var(--muted)', fontSize: 13 }}>
                …
              </div>
            )}
            {error && (
              <div style={{ alignSelf: 'flex-start', color: 'var(--red)', fontSize: 11, padding: '0 4px' }}>{error}</div>
            )}
          </div>
          )}

          {view === 'chat' && (
          <div style={{
            padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0,
            maxWidth: maximized ? 720 : 'none', width: '100%', margin: maximized ? '0 auto' : 0,
          }}>
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
          )}
        </div>
      )}
    </>
  );
}
