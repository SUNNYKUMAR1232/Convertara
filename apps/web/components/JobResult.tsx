'use client';

import { formatBytes } from '@/lib/api';
import type { Job } from '@/lib/api';

/**
 * Shows what was decided, what was produced, and whether it satisfies the
 * constraints. The plan is displayed on purpose - if a model chose the
 * operations, the user should be able to see exactly what it chose.
 */
export function JobResult({ job }: { job: Job }) {
  const planned = job.plan;
  const fastPath = job.planSource === 'fast-path';

  return (
    <>
      <section className="panel">
        <h2>
          Plan
          <span className="sub">{planned?.intent}</span>
        </h2>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className={`badge ${fastPath ? 'fast' : 'llm'}`}>
            {fastPath ? 'No model called' : job.planSource === 'explicit' ? 'Caller-supplied plan' : 'Model-planned'}
          </span>
          {job.lane && <span className="badge">{job.lane === 'sync' ? 'Inline' : 'Queued'}</span>}
          {typeof job.timings.total === 'number' && (
            <span className="badge">{job.timings.total} ms processing</span>
          )}
        </div>

        <pre className="code">
          {JSON.stringify(
            { operations: planned?.operations ?? [], constraints: planned?.constraints ?? {} },
            null,
            2,
          )}
        </pre>

        {planned?.notes && <p className="muted" style={{ marginTop: 10 }}>{planned.notes}</p>}

        {Object.keys(job.timings).length > 0 && (
          <div className="timings">
            {Object.entries(job.timings).map(([key, value]) => (
              <span key={key}>
                {key}: {value}
                {key === 'attempts' || key === 'cost' ? '' : 'ms'}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>
          Result
          {job.evaluation && (
            <span className="sub">
              <span className={`badge ${job.evaluation.pass ? 'ok' : 'bad'}`}>
                {job.evaluation.pass ? 'All constraints met' : 'Constraints not met'}
              </span>
            </span>
          )}
        </h2>

        {/* `partial` is a warning with a working download attached, not an
            error. Rendering it red would tell the user to throw the file away. */}
        {job.error && (
          <div className={`alert ${job.status === 'partial' ? 'warn' : 'bad'}`} style={{ marginBottom: 12 }}>
            {job.status === 'partial' ? 'Closest we could get: ' : ''}
            {job.error.message}
          </div>
        )}

        {job.outputs.length > 0 ? (
          <div className="results">
            {job.outputs.map((output) => (
              <div className="result" key={output.id}>
                <span className="name">{output.filename}</span>
                <span className="meta">
                  {formatBytes(output.bytes)}
                  {typeof output.meta.width === 'number' && ` · ${output.meta.width}×${output.meta.height}`}
                  {typeof output.meta.pages === 'number' && ` · ${output.meta.pages} pages`}
                </span>
                <a className="download" href={`/api${output.downloadUrl}`} download>
                  Download
                </a>
              </div>
            ))}
          </div>
        ) : (
          job.status !== 'failed' && <p className="muted">No output yet.</p>
        )}

        {job.evaluation && job.evaluation.checks.length > 0 && (
          <ul className="checks">
            {job.evaluation.checks.map((check) => (
              <li key={check.name}>
                <span className="label">{check.name}</span>
                <span className={`badge ${check.pass ? 'ok' : 'bad'}`}>{check.pass ? 'pass' : 'fail'}</span>
                <span className="muted">{check.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
