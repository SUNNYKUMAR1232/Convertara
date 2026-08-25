'use client';

import { useMemo, useState } from 'react';
import { formatBytes } from '@/lib/chat';
import type { Attachment } from '@/lib/chat';

function group(mime: string): string {
  if (mime.startsWith('image/')) return 'images';
  if (mime === 'application/pdf') return 'PDFs';
  if (mime.includes('zip')) return 'archives';
  return 'other';
}

/**
 * The attached-files tray.
 *
 * Below a handful of files a plain list is clearest. Above it, a list of forty
 * rows buries the composer, so it collapses to counts by type - which are also
 * the things people select by. Typing "the images" does the same job; this is
 * for when the subset is not describable, like four particular photos.
 */
export function AttachmentTray({
  files,
  selected,
  onChange,
}: {
  files: Attachment[];
  /** Ids to send. Everything is selected until someone changes it. */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const compact = files.length > 3;

  const groups = useMemo(() => {
    const byType = new Map<string, Attachment[]>();
    for (const file of files) {
      const key = group(file.mime);
      byType.set(key, [...(byType.get(key) ?? []), file]);
    }
    return [...byType.entries()];
  }, [files]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const setAll = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  };

  const totalBytes = files.filter((f) => selected.has(f.id)).reduce((n, f) => n + f.bytes, 0);

  if (!compact) {
    return (
      <div className="pending">
        {files.map((file) => (
          <span className="pill" key={file.id}>
            {file.filename}
            <em>{formatBytes(file.bytes)}</em>
            <button onClick={() => setAll([file.id], false)} aria-label={`Remove ${file.filename}`}>
              ×
            </button>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="tray">
      <div className="tray-head">
        <strong>
          {selected.size} of {files.length} files
        </strong>
        <span className="muted">{formatBytes(totalBytes)}</span>

        {groups.map(([name, group]) => {
          const ids = group.map((f) => f.id);
          const on = ids.every((id) => selected.has(id));
          return (
            <button
              key={name}
              className={`chip${on ? ' on' : ''}`}
              onClick={() => setAll(ids, !on)}
              title={`${on ? 'Deselect' : 'Select'} the ${name}`}
            >
              {group.length} {name}
            </button>
          );
        })}

        <span className="spacer" />
        <button className="chip" onClick={() => setAll(files.map((f) => f.id), selected.size !== files.length)}>
          {selected.size === files.length ? 'None' : 'All'}
        </button>
        <button className="chip" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Hide' : 'List'}
        </button>
      </div>

      {expanded && (
        <ul className="tray-list">
          {files.map((file) => (
            <li key={file.id}>
              <label>
                <input type="checkbox" checked={selected.has(file.id)} onChange={() => toggle(file.id)} />
                <span className="n">{file.filename}</span>
                <span className="s">{formatBytes(file.bytes)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
