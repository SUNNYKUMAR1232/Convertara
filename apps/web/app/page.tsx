'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AttachmentTray } from '@/components/AttachmentTray';
import { ImageEditor } from '@/components/ImageEditor';
import type { Adjustment } from '@/components/ImageEditor';
import { Message } from '@/components/Message';
import { chatApi, formatBytes, sendAdjustment, sendTurn, uploadFiles } from '@/lib/chat';
import type { Attachment, ChatMessage, Conversation, TurnEvent } from '@/lib/chat';

const SUGGESTIONS = [
  'Compress this to 300 KB ±5%',
  'Convert to WebP',
  'Resize to 1200×800',
  'Merge these PDFs',
  'Get it under 2 MB but keep the quality high',
];

export default function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [editing, setEditing] = useState<Attachment | null>(null);
  // Everything is selected until someone says otherwise.
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void chatApi.conversations().then(setConversations);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const attach = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(Array.from(files));
      setPending((current) => [...current, ...uploaded]);
      setPicked((current) => new Set([...current, ...uploaded.map((f) => f.id)]));
      composer.current?.focus();
    } catch (error) {
      setMessages((current) => [...current, systemNote((error as Error).message)]);
    } finally {
      setUploading(false);
    }
  }, []);

  async function open(id: string) {
    const loaded = await chatApi.conversation(id);
    setConversationId(id);
    setMessages(loaded.messages);
    setPending([]);
    setPicked(new Set());
    setSidebar(false);
  }

  function reset() {
    setConversationId(undefined);
    setMessages([]);
    setPending([]);
    setPicked(new Set());
    setSidebar(false);
  }

  async function send() {
    const text = input.trim();
    const attachments = pending.filter((f) => picked.has(f.id));
    if ((text === '' && attachments.length === 0) || busy) return;

    setInput('');
    setPending([]);
    setPicked(new Set());
    setBusy(true);

    // The assistant bubble goes in immediately and fills as tokens land.
    const placeholderId = `pending-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: placeholderId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        jobId: null,
        attachments: [],
        streaming: true,
        status: 'Thinking',
      },
    ]);

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((current) => current.map((m) => (m.id === placeholderId ? fn(m) : m)));

    await consume(
      sendTurn({ conversationId, text, fileIds: attachments.map((f) => f.id) }),
      placeholderId,
      patch,
    );
  }

  /** Shared by the composer and the editor - both produce the same event stream. */
  async function consume(
    stream: AsyncGenerator<TurnEvent>,
    placeholderId: string,
    patch: (fn: (m: ChatMessage) => ChatMessage) => void,
  ) {
    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'conversation':
            setConversationId(event.id);
            break;
          case 'message':
            // The server's copy of the user turn, with resolved attachments.
            setMessages((current) => [
              ...current.filter((m) => m.id !== placeholderId),
              event.message,
              ...current.filter((m) => m.id === placeholderId),
            ]);
            break;
          case 'status':
            patch((m) => ({ ...m, status: event.text }));
            break;
          case 'progress':
            patch((m) => ({ ...m, progress: event.fraction, status: event.stage ?? m.status }));
            break;
          case 'delta':
            patch((m) => ({ ...m, text: m.text + event.text }));
            break;
          case 'done':
            patch(() => ({ ...event.message, streaming: false }));
            break;
          case 'error':
            patch((m) => ({ ...m, text: event.message, streaming: false }));
            break;
        }
      }
    } catch (error) {
      patch((m) => ({ ...m, text: (error as Error).message, streaming: false }));
    } finally {
      setBusy(false);
      patch((m) => ({ ...m, streaming: false }));
      void chatApi.conversations().then(setConversations);
    }
  }

  async function applyAdjustment(adjustment: Adjustment) {
    if (!editing || !conversationId || busy) return;
    setBusy(true);

    const placeholderId = `pending-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: placeholderId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        jobId: null,
        attachments: [],
        streaming: true,
        status: 'Applying',
      },
    ]);

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((current) => current.map((m) => (m.id === placeholderId ? fn(m) : m)));

    await consume(
      sendAdjustment({ conversationId, fileId: editing.id, adjustment }),
      placeholderId,
      patch,
    );
    setEditing(null);
  }

  const empty = messages.length === 0;

  return (
    <div
      className={`chat${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void attach(event.dataTransfer.files);
      }}
    >
      <aside className={`sidebar${sidebar ? ' open' : ''}`}>
        <div className="side-head">
          <button className="newchat" onClick={reset}>
            New chat
          </button>
        </div>

        <div className="threads">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`thread${conversation.id === conversationId ? ' current' : ''}`}
              onClick={() => void open(conversation.id)}
            >
              <span className="t">{conversation.title}</span>
              <span
                className="x"
                role="button"
                tabIndex={0}
                aria-label="Delete conversation"
                onClick={async (event) => {
                  event.stopPropagation();
                  await chatApi.remove(conversation.id);
                  if (conversation.id === conversationId) reset();
                  setConversations(await chatApi.conversations());
                }}
              >
                ×
              </span>
            </button>
          ))}
          {conversations.length === 0 && <p className="none">No conversations yet.</p>}
        </div>

        <div className="side-foot">
          <Link href="/settings">Settings</Link>
        </div>
      </aside>

      <main className="thread-pane">
        <header className="bar">
          <button className="hamburger" onClick={() => setSidebar((s) => !s)} aria-label="Conversations">
            ☰
          </button>
          <span className="title">Convertara</span>
          <Link href="/settings" className="gear">
            Settings
          </Link>
        </header>

        <div className="messages">
          {empty ? (
            <div className="welcome">
              <h1>What should I do with your file?</h1>
              <p>
                Drop in an image, PDF or zip and say what you need. Exact sizes are the point — ask for 300 KB
                ±5% and you get 300 KB ±5%, verified.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} onClick={() => setInput(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <Message key={message.id} message={message} onEdit={setEditing} />
            ))
          )}
          <div ref={bottom} />
        </div>

        <div className="composer-wrap">
          {pending.length > 0 && (
            <AttachmentTray
              files={pending}
              selected={picked}
              onChange={(next) => {
                // Dropping a pill from the short list removes it outright;
                // unticking in the long list only deselects.
                if (pending.length <= 3) setPending((current) => current.filter((f) => next.has(f.id)));
                setPicked(next);
              }}
            />
          )}

          <div className="composer">
            <button
              className="clip"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              aria-label="Attach files"
              title="Attach files"
            >
              {uploading ? '···' : '+'}
            </button>

            <textarea
              ref={composer}
              rows={1}
              value={input}
              placeholder="Ask for anything, or describe what to do with the file"
              onChange={(event) => {
                setInput(event.target.value);
                event.target.style.height = 'auto';
                event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />

            <button
              className="send"
              onClick={() => void send()}
              disabled={busy || (input.trim() === '' && picked.size === 0)}
              aria-label="Send"
            >
              {busy ? '■' : '↑'}
            </button>
          </div>

          <p className="footnote">
            Enter sends, Shift+Enter adds a line. Files are deleted automatically after 24 hours.
          </p>
        </div>
      </main>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void attach(event.target.files);
          event.target.value = '';
        }}
      />

      {editing && (
        <div className="editor-veil" onPointerDown={(event) => event.target === event.currentTarget && setEditing(null)}>
          <ImageEditor
            file={editing}
            busy={busy}
            onApply={(adjustment) => void applyAdjustment(adjustment)}
            onClose={() => setEditing(null)}
          />
        </div>
      )}

      {dragging && <div className="dropveil">Drop to attach</div>}
    </div>
  );
}

function systemNote(text: string): ChatMessage {
  return {
    id: `note-${Date.now()}`,
    role: 'assistant',
    text,
    createdAt: new Date().toISOString(),
    jobId: null,
    attachments: [],
  };
}
