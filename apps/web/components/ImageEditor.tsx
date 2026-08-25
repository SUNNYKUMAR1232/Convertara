'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@/lib/chat';

export type Adjustment =
  | { op: 'image.crop'; left: number; top: number; width: number; height: number }
  | { op: 'image.resize'; width?: number; height?: number; fit: 'inside' | 'cover' | 'fill' }
  | { op: 'image.rotate'; angle: number; flip: boolean; flop: boolean };

type Mode = 'crop' | 'resize' | 'rotate';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Direct manipulation for the operations that are actually spatial.
 *
 * "Crop a bit off the left" is a bad sentence and a good drag. Everything here
 * works in the image's real pixel coordinates and only scales for display, so
 * what gets sent is exactly what was drawn - and each apply runs against the
 * file shown, not a re-compressed copy of it.
 */
export function ImageEditor({
  file,
  busy,
  onApply,
  onClose,
}: {
  file: Attachment;
  busy: boolean;
  onApply: (adjustment: Adjustment) => void;
  onClose: () => void;
}) {
  const naturalWidth = typeof file.meta.width === 'number' ? file.meta.width : 0;
  const naturalHeight = typeof file.meta.height === 'number' ? file.meta.height : 0;

  const [mode, setMode] = useState<Mode>('crop');
  const [box, setBox] = useState<Box>({ left: 0, top: 0, width: naturalWidth, height: naturalHeight });
  const [width, setWidth] = useState(naturalWidth);
  const [height, setHeight] = useState(naturalHeight);
  const [lockAspect, setLockAspect] = useState(true);
  const [angle, setAngle] = useState(0);
  const [flip, setFlip] = useState(false);
  const [flop, setFlop] = useState(false);

  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'move' | 'new' | 'se'; startX: number; startY: number; origin: Box } | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const measure = () => {
      const element = surface.current;
      if (!element || naturalWidth === 0) return;
      setScale(element.clientWidth / naturalWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [naturalWidth]);

  if (naturalWidth === 0 || naturalHeight === 0) return null;

  const aspect = naturalWidth / naturalHeight;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  /**
   * The drag listens on `window`, not on the image.
   *
   * With handlers on the element, releasing the mouse anywhere outside it never
   * fires pointerup, so the drag stays live and the box keeps following the
   * cursor - including on the way to the Apply button. The symptom is that what
   * you applied is not what you drew.
   */
  function pointerDown(event: React.PointerEvent, kind: 'move' | 'new' | 'se') {
    if (mode !== 'crop') return;
    event.preventDefault();

    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;

    if (kind === 'new') {
      const start = { left: Math.round(x), top: Math.round(y), width: 1, height: 1 };
      setBox(start);
      drag.current = { kind: 'se', startX: x, startY: y, origin: start };
    } else {
      drag.current = { kind, startX: x, startY: y, origin: box };
    }

    const move = (native: PointerEvent) => {
      const state = drag.current;
      const bounds = surface.current?.getBoundingClientRect();
      if (!state || !bounds) return;

      const dx = (native.clientX - bounds.left) / scale - state.startX;
      const dy = (native.clientY - bounds.top) / scale - state.startY;

      if (state.kind === 'move') {
        setBox({
          ...state.origin,
          left: Math.round(clamp(state.origin.left + dx, 0, naturalWidth - state.origin.width)),
          top: Math.round(clamp(state.origin.top + dy, 0, naturalHeight - state.origin.height)),
        });
        return;
      }

      setBox({
        left: state.origin.left,
        top: state.origin.top,
        width: Math.round(clamp(state.origin.width + dx, 8, naturalWidth - state.origin.left)),
        height: Math.round(clamp(state.origin.height + dy, 8, naturalHeight - state.origin.top)),
      });
    };

    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function apply() {
    if (mode === 'crop') {
      onApply({ op: 'image.crop', left: box.left, top: box.top, width: box.width, height: box.height });
    } else if (mode === 'resize') {
      onApply({ op: 'image.resize', width, height, fit: 'fill' });
    } else {
      onApply({ op: 'image.rotate', angle, flip, flop });
    }
  }

  const changed =
    mode === 'crop'
      ? box.width !== naturalWidth || box.height !== naturalHeight || box.left !== 0 || box.top !== 0
      : mode === 'resize'
        ? width !== naturalWidth || height !== naturalHeight
        : angle !== 0 || flip || flop;

  return (
    <div className="editor">
      <div className="editor-head">
        <div className="modes">
          {(['crop', 'resize', 'rotate'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m[0]!.toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <button className="close" onClick={onClose} aria-label="Close editor">
          ×
        </button>
      </div>

      <div
        className={`surface${mode === 'crop' ? ' cropping' : ''}`}
        ref={surface}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) pointerDown(event, 'new');
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api${file.downloadUrl}?inline=1`}
          alt={file.filename}
          draggable={false}
          style={
            mode === 'rotate'
              ? { transform: `rotate(${angle}deg) scaleX(${flop ? -1 : 1}) scaleY(${flip ? -1 : 1})` }
              : undefined
          }
        />

        {mode === 'crop' && (
          <div
            className="cropbox"
            style={{
              left: box.left * scale,
              top: box.top * scale,
              width: box.width * scale,
              height: box.height * scale,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              pointerDown(event, 'move');
            }}
          >
            <span
              className="handle se"
              onPointerDown={(event) => {
                event.stopPropagation();
                pointerDown(event, 'se');
              }}
            />
          </div>
        )}
      </div>

      {mode === 'crop' && (
        <div className="controls">
          <span className="readout">
            {box.width} × {box.height} at ({box.left}, {box.top})
          </span>
          <button
            className="ghost small"
            onClick={() => setBox({ left: 0, top: 0, width: naturalWidth, height: naturalHeight })}
          >
            Reset
          </button>
          <span className="tip">Drag on the image to draw a box, or drag the box to move it.</span>
        </div>
      )}

      {mode === 'resize' && (
        <div className="controls">
          <label>
            Width
            <input
              type="number"
              min={1}
              value={width}
              onChange={(event) => {
                const next = Number(event.target.value) || 1;
                setWidth(next);
                if (lockAspect) setHeight(Math.max(1, Math.round(next / aspect)));
              }}
            />
          </label>
          <label>
            Height
            <input
              type="number"
              min={1}
              value={height}
              onChange={(event) => {
                const next = Number(event.target.value) || 1;
                setHeight(next);
                if (lockAspect) setWidth(Math.max(1, Math.round(next * aspect)));
              }}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={lockAspect} onChange={(event) => setLockAspect(event.target.checked)} />
            Lock aspect
          </label>
          <span className="presets">
            {[25, 50, 75].map((percent) => (
              <button
                key={percent}
                className="chip"
                onClick={() => {
                  setWidth(Math.max(1, Math.round((naturalWidth * percent) / 100)));
                  setHeight(Math.max(1, Math.round((naturalHeight * percent) / 100)));
                }}
              >
                {percent}%
              </button>
            ))}
            <button
              className="chip"
              onClick={() => {
                setWidth(naturalWidth);
                setHeight(naturalHeight);
              }}
            >
              Reset
            </button>
          </span>
        </div>
      )}

      {mode === 'rotate' && (
        <div className="controls">
          <span className="presets">
            <button className="chip" onClick={() => setAngle((a) => (a - 90 + 360) % 360)}>
              ⟲ 90°
            </button>
            <button className="chip" onClick={() => setAngle((a) => (a + 90) % 360)}>
              ⟳ 90°
            </button>
            <button className="chip" onClick={() => setFlop((f) => !f)}>
              Flip horizontal
            </button>
            <button className="chip" onClick={() => setFlip((f) => !f)}>
              Flip vertical
            </button>
          </span>
          <label>
            Angle
            <input
              type="number"
              value={angle}
              step={1}
              onChange={(event) => setAngle(Number(event.target.value) || 0)}
            />
          </label>
        </div>
      )}

      <div className="editor-foot">
        <span className="source">
          {file.filename} · {naturalWidth}×{naturalHeight}
        </span>
        <button onClick={apply} disabled={busy || !changed}>
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
}
