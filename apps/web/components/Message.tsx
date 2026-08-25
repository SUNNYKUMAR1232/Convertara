'use client';

import { formatBytes } from '@/lib/chat';
import type { ChatMessage } from '@/lib/chat';

const IMAGE = /^image\//;

export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="avatar" aria-hidden>
        {isUser ? 'You' : 'C'}
      </div>

      <div className="bubble">
        {message.text !== '' && <div className="text">{renderText(message.text)}</div>}

        {/* A working reply with nothing in it yet reads as a hang, so the
            status line stands in until the first token arrives. */}
        {message.streaming && message.text === '' && (
          <div className="working">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            {message.status ?? 'Thinking'}
            {typeof message.progress === 'number' && message.progress > 0 && (
              <span className="pct">{Math.round(message.progress * 100)}%</span>
            )}
          </div>
        )}

        {typeof message.progress === 'number' && message.progress > 0 && message.streaming && (
          <div className="progress">
            <div style={{ width: `${Math.round(message.progress * 100)}%` }} />
          </div>
        )}

        {message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((file) => (
              <div className="attachment" key={file.id}>
                {IMAGE.test(file.mime) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api${file.downloadUrl}?inline=1`} alt={file.filename} className="thumb" />
                ) : (
                  <span className="glyph">{glyph(file.mime)}</span>
                )}

                <span className="info">
                  <span className="name">{file.filename}</span>
                  <span className="sub">
                    {formatBytes(file.bytes)}
                    {typeof file.meta.width === 'number' && ` · ${file.meta.width}×${file.meta.height}`}
                    {typeof file.meta.pages === 'number' && ` · ${file.meta.pages} pages`}
                  </span>
                </span>

                {!isUser && (
                  <a className="get" href={`/api${file.downloadUrl}`} download={file.filename}>
                    Download
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Just enough markdown for the capability list: bold, and paragraphs. */
function renderText(text: string) {
  return text.split('\n').map((line, index) => {
    if (line.trim() === '') return <br key={index} />;
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={index}>
        {parts.map((part, i) =>
          part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
        )}
      </p>
    );
  });
}

function glyph(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('zip')) return 'ZIP';
  return 'FILE';
}
