import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Menu, Plus, MessageSquare, Trash2, Copy, Check, Send, Square, X, PanelLeftClose, Sparkles, ArrowDown, Clock3 } from 'lucide-react';

const STORAGE_KEY = 'skgpt.conversations.v1';
const CHAT_API_URL = 'http://localhost:3001/api/chat';
const readChats = () => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter(c => c && typeof c.id === 'string' && Array.isArray(c.messages)) : [];
  } catch { return []; }
};
const makeChat = () => ({ id: crypto.randomUUID(), title: 'New conversation', messages: [], updatedAt: Date.now() });
const titleFrom = text => text.trim().replace(/\s+/g, ' ').slice(0, 40) || 'New conversation';

function Message({ message, onCopy, copied }) {
  return <article className={`message-row ${message.role}`}>
    <div className={`avatar ${message.role}`}>{message.role === 'user' ? 'Y' : <span>SK</span>}</div>
    <div className="message-content">
      <div className="message-head"><strong>{message.role === 'user' ? 'You' : 'Sgpt'}</strong>{message.role === 'model' && message.text && <button className="icon-button copy-message" title="Copy response" onClick={() => onCopy(message.text)}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>}</div>
      {message.text ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{code({className, children, ...props}) { const content = String(children).replace(/\n$/, ''); return className || content.includes('\n') ? <CodeBlock>{content}</CodeBlock> : <code {...props}>{children}</code>; }}}>{message.text}</ReactMarkdown></div> : <div className="waiting-label">Waiting for Sgpt...</div>}
    </div>
  </article>;
}

function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {} };
  return <div className="code-wrap"><div className="code-tools"><span>Code</span><button onClick={copy}><Copy size={13}/>{copied ? 'Copied' : 'Copy code'}</button></div><pre><code>{children}</code></pre></div>;
}

export default function App() {
  const [chats, setChats] = useState(readChats);
  const [activeId, setActiveId] = useState(() => readChats()[0]?.id || null);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const abortRef = useRef(null);
  const pendingMessageRef = useRef(null);
  const sendLock = useRef(false);
  const bottomRef = useRef(null);
  const scrollRef = useRef(null);
  const activeChat = chats.find(c => c.id === activeId) || null;

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(chats)); } catch { setError('Could not save conversation history in this browser.'); } }, [chats]);
  useEffect(() => { if (!activeChat && chats.length) setActiveId(chats[0].id); }, [activeChat, chats]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [activeChat?.messages]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const pending = pendingMessageRef.current;
    if (pending) {
      setChats(prev => prev.map(chat => chat.id === pending.chatId ? { ...chat, messages: chat.messages.filter(message => message.id !== pending.messageId || message.text) } : chat));
      pendingMessageRef.current = null;
    }
    sendLock.current = false;
    setGenerating(false);
  }, []);
  const newChat = () => { stop(); setError(''); const chat = makeChat(); setChats(prev => [chat, ...prev]); setActiveId(chat.id); setInput(''); setDrawer(false); setHistoryOpen(false); };
  const openChat = id => { if (generating) stop(); setActiveId(id); setDrawer(false); setHistoryOpen(false); setError(''); };
  const deleteChat = id => { if (id === activeId && generating) stop(); setChats(prev => prev.filter(c => c.id !== id)); if (id === activeId) { const next = chats.find(c => c.id !== id); setActiveId(next?.id || null); } };
  const clearHistory = () => { stop(); setChats([]); setActiveId(null); setHistoryOpen(false); setDrawer(false); };
  const copyText = async text => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { setError('Clipboard access is unavailable in this browser.'); } };

  const send = async () => {
    const text = input.trim();
    if (!text || sendLock.current || generating) return;
    sendLock.current = true; setError('');
    let chat = chats.find(c => c.id === activeId);
    if (!chat) { chat = makeChat(); setChats(prev => [chat, ...prev]); setActiveId(chat.id); }
    const userMessage = { role: 'user', text, id: crypto.randomUUID() };
    const assistantMessage = { role: 'model', text: '', id: crypto.randomUUID() };
    const conversation = [...chat.messages, userMessage, assistantMessage];
    setChats(prev => prev.map(c => c.id === chat.id ? { ...c, title: c.messages.length ? c.title : titleFrom(text), messages: conversation, updatedAt: Date.now() } : c));
    setInput(''); setGenerating(true);
    const controller = new AbortController(); abortRef.current = controller;
    pendingMessageRef.current = { chatId: chat.id, messageId: assistantMessage.id };
    let received = '';
    try {
      const response = await fetch(CHAT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ messages: [{ role: 'user', text }] }),
        signal: controller.signal
      });
      if (!response.ok) { let payload = {}; try { payload = await response.json(); } catch {} throw new Error(payload.error || (response.status === 503 ? 'Gemini service is not configured yet.' : 'Something went wrong. Please check your Gemini API configuration and try again.')); }
      if (!response.body) throw new Error('The server returned an empty response stream. Please try again.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let streamError = ''; let streamEnded = false;
      const updateAssistant = () => setChats(prev => prev.map(c => c.id === chat.id ? { ...c, messages: c.messages.map(message => message.id === assistantMessage.id ? { ...message, text: received } : message), updatedAt: Date.now() } : c));
      const applyFrame = frame => {
        const lines = frame.split('\n'); const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (event === 'token') {
          try {
            const token = JSON.parse(data);
            if (typeof token !== 'string') throw new TypeError('Expected a string token');
            received += token;
            updateAssistant();
          } catch { streamError = 'The server returned a malformed Gemini response.'; }
        }
        if (event === 'error') { try { streamError = JSON.parse(data); } catch { streamError = 'Something went wrong while generating the response.'; } }
        if (event === 'end') streamEnded = true;
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || ''; frames.forEach(applyFrame);
        if (streamEnded) { await reader.cancel().catch(() => {}); break; }
        if (done) break;
      }
      if (buffer.trim()) applyFrame(buffer);
      if (streamError) throw new Error(streamError);
      if (!streamEnded && !controller.signal.aborted) throw new Error('The response stream ended unexpectedly. Any received text has been preserved.');
      if (!received.trim() && !controller.signal.aborted) {
        setChats(prev => prev.map(c => c.id === chat.id ? { ...c, messages: c.messages.filter(message => message.id !== assistantMessage.id) } : c));
        setError('Gemini returned an empty response. Please try again.');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Unable to reach SKGPT. Check that the server is running and try again.');
        if (!received) setChats(prev => prev.map(c => c.id === chat.id ? { ...c, messages: c.messages.filter(message => message.id !== assistantMessage.id) } : c));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        sendLock.current = false;
        setGenerating(false);
      }
      if (pendingMessageRef.current?.messageId === assistantMessage.id) pendingMessageRef.current = null;
    }
  };

  const handleScroll = () => { const el = scrollRef.current; if (el) setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 250); };
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const sidebar = <><div className="sidebar-top"><div className="section-label">Recent <span>{chats.length}</span></div><button className="icon-button close-drawer" onClick={() => setDrawer(false)} aria-label="Close sidebar"><X size={18}/></button></div><button className="new-chat" onClick={newChat}><Plus size={16}/>New chat</button><div className="chat-list">{sorted.length ? sorted.map(chat => <div className={`chat-item ${chat.id === activeId ? 'active' : ''}`} key={chat.id}><button className="chat-select" onClick={() => openChat(chat.id)}><MessageSquare size={15}/><span>{chat.title}</span></button><button className="delete-chat" title="Delete conversation" onClick={() => deleteChat(chat.id)}><Trash2 size={14}/></button></div>) : <div className="empty-history">Your conversations will show up here.</div>}</div><div className="sidebar-footer"><div className="profile-mark">S</div><div><strong>SKGPT</strong><small>Private workspace</small></div><span className="online-dot"/></div></>;

  return <div className="app-shell">
    <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setDrawer(true)} aria-label="Open sidebar"><Menu size={19}/></button><div className="brand"><span className="brand-mark">SK</span><span>SKGPT</span></div><div className="top-actions"><div className="secure-pill"><span/>Key stays server-side</div><button className="history-button" onClick={() => setHistoryOpen(true)}><Clock3 size={15}/>History</button></div></header>
    <div className="workspace"><aside className="sidebar">{sidebar}</aside><main className="main-panel"><div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
      {activeChat?.messages.length ? <div className="messages-wrap">{activeChat.messages.map(message => <Message key={message.id} message={message} onCopy={copyText} copied={copied}/>)}</div> : <div className="welcome"><div className="welcome-icon"><Sparkles size={23}/></div><div className="eyebrow">A little more clarity</div><h1>What can I help you<br/><em>think through?</em></h1><p>A thoughtful space for ideas, questions, and everything in between.</p><div className="prompt-cards"><button onClick={() => setInput('Help me think through a difficult decision')}><span>01</span><strong>Work through a decision</strong><small>Get a fresh perspective</small></button><button onClick={() => setInput('Explain a complex topic in simple terms')}><span>02</span><strong>Learn something new</strong><small>Make the complex feel clear</small></button><button onClick={() => setInput('Help me write a thoughtful message')}><span>03</span><strong>Find the right words</strong><small>Start with a blank page</small></button></div></div>}
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}<div ref={bottomRef}/>
    </div>{showJump && <button className="jump-bottom" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}><ArrowDown size={15}/></button>}
    <div className="composer-area"><div className="composer"><textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Message Sgpt..." rows={1} aria-label="Message Sgpt"/><div className="composer-bottom"><span className="composer-hint">Thoughtful answers, one message at a time</span>{generating ? <button className="stop-button" onClick={stop}><Square size={13} fill="currentColor"/>Stop</button> : <button className="send-button" onClick={send} disabled={!input.trim()} aria-label="Send message"><span>Send</span><Send size={15}/></button>}</div></div><div className="disclaimer">Sgpt can make mistakes. Consider checking important information.</div></div>
    </main></div>
    {drawer && <div className="mobile-overlay" onClick={() => setDrawer(false)}><aside className="drawer" onClick={e => e.stopPropagation()}>{sidebar}</aside></div>}
    {historyOpen && <div className="modal-backdrop" onClick={() => setHistoryOpen(false)}><section className="history-modal" onClick={e => e.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">YOUR SPACE</span><h2>Conversation history</h2></div><button className="icon-button" onClick={() => setHistoryOpen(false)} aria-label="Close history"><X size={18}/></button></div><div className="history-list">{sorted.length ? sorted.map(chat => <div className="history-row" key={chat.id}><button onClick={() => openChat(chat.id)}><MessageSquare size={16}/><span><strong>{chat.title}</strong><small>{chat.messages.length} messages · {new Date(chat.updatedAt).toLocaleDateString()}</small></span></button><button className="delete-chat" onClick={() => deleteChat(chat.id)} aria-label={`Delete ${chat.title}`}><Trash2 size={15}/></button></div>) : <div className="history-empty"><Clock3 size={25}/><span>No conversations yet</span><small>Your saved conversations will appear here.</small></div>}</div><div className="modal-foot"><span>Saved on this device</span><button className="clear-button" onClick={clearHistory} disabled={!chats.length}><Trash2 size={14}/>Clear history</button></div></section></div>}
  </div>;
}
