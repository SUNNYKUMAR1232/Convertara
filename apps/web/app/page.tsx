'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Nav } from '@/components/Nav';
import { JobResult } from '@/components/JobResult';
import { api, formatBytes } from '@/lib/api';
import type { Capabilities, Job } from '@/lib/api';

const EXAMPLES = [
  'Convert to WebP',
  'Compress to 300 KB ±5%',
  'Resize to 1200x800 and strip metadata',
  'Get it under 2MB but keep the quality high',
  'Merge these PDFs',
  'Zip these up',
];

export default function Workbench() {
  const [files, setFiles] = useState<File[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ fraction: number; stage: string } | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.capabilities().then(setCapabilities).catch(() => undefined);
  }, []);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    setFiles((current) => [...current, ...Array.from(incoming)].slice(0, 64));
    setError(null);
  }, []);

  async function run() {
    if (files.length === 0 || prompt.trim() === '') return;
    setBusy(true);
    setError(null);
    setJob(null);
    setProgress(null);

    try {
      const started = await api.processUpload(files, prompt);
      setJob(started);

      // A queued job keeps streaming; a sync one already came back finished.
      if (started.status === 'queued' || started.status === 'running') {
        const stop = api.watch(started.id, (event) => {
          if (typeof event.progress === 'number') {
            setProgress({ fraction: event.progress, stage: event.stage ?? '' });
          }
          if (event.type === 'succeeded' || event.type === 'failed') {
            stop();
            api.job(started.id).then(setJob).catch(() => undefined);
            setProgress(null);
          }
        });
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="shell">
      <Nav />

      <section className="panel">
        <h2>
          Files
          {capabilities && (
            <span className="sub">
              up to {formatBytes(capabilities.limits.maxUploadBytes)} each, {capabilities.limits.maxFilesPerRequest} max
            </span>
          )}
        </h2>

        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <strong>Drop files here</strong>
          <p>images, PDFs and zip archives — or click to browse</p>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => addFiles(event.target.files)}
        />

        {files.length > 0 && (
          <>
            <ul className="filelist">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`}>
                  <span className="name">{file.name}</span>
                  <span className="meta">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ marginTop: 8 }}>
              {files.length} file{files.length === 1 ? '' : 's'}, {formatBytes(totalBytes)} total
            </p>
          </>
        )}
      </section>

      <section className="panel">
        <h2>
          What should happen?<span className="sub">plain language is fine</span>
        </h2>

        <div className="row">
          <textarea
            value={prompt}
            placeholder="Compress this to 300 KB, give or take 5 percent"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void run();
            }}
          />
          <button onClick={() => void run()} disabled={busy || files.length === 0 || prompt.trim() === ''}>
            {busy ? 'Working…' : 'Run'}
          </button>
        </div>

        <div className="examples">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="chip" onClick={() => setPrompt(example)}>
              {example}
            </button>
          ))}
        </div>
      </section>

      {error && <div className="alert bad">{error}</div>}

      {progress && (
        <section className="panel">
          <h2>
            Processing<span className="sub">{progress.stage}</span>
          </h2>
          <div className="progress">
            <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
        </section>
      )}

      {job && <JobResult job={job} />}

      {capabilities && (
        <section className="panel">
          <h2>
            What this deployment can do
            <span className="sub">
              {capabilities.capabilities.filter((c) => c.available).length} capabilities · AI mode: {capabilities.aiMode}
            </span>
          </h2>
          <div className="grid">
            {capabilities.capabilities.map((capability) => (
              <div className="cap" key={capability.name} style={{ opacity: capability.available ? 1 : 0.45 }}>
                <div className="n">
                  {capability.name}
                  {!capability.available && ' — unavailable'}
                </div>
                <div className="d">{capability.description}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
