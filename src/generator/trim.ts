// Draggable trim window over the waveform canvas: pick which ≤10s of a longer
// clip goes on the card. Dragging inside the window moves it; dragging near an
// edge resizes it.

import { CODEC2_SAMPLE_RATE } from '../lib/codec2';
import { drawWaveform, MAX_SECONDS } from '../lib/audio';

export interface TrimState {
  startSec: number;
  endSec: number;
}

export function attachTrim(
  canvas: HTMLCanvasElement,
  pcm: Int16Array,
  onChange: (t: TrimState) => void,
): TrimState {
  const durationSec = pcm.length / CODEC2_SAMPLE_RATE;
  const state: TrimState = { startSec: 0, endSec: Math.min(durationSec, MAX_SECONDS) };

  const redraw = () => drawWaveform(canvas, pcm, [state.startSec, state.endSec]);
  redraw();

  if (durationSec <= MAX_SECONDS) return state; // nothing to trim

  const secAt = (clientX: number): number => {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(durationSec, ((clientX - rect.left) / rect.width) * durationSec));
  };

  type Drag = { kind: 'move' | 'start' | 'end'; grabOffset: number } | null;
  let drag: Drag = null;
  const EDGE_SEC = durationSec * 0.03;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const s = secAt(e.clientX);
    if (Math.abs(s - state.startSec) < EDGE_SEC) drag = { kind: 'start', grabOffset: 0 };
    else if (Math.abs(s - state.endSec) < EDGE_SEC) drag = { kind: 'end', grabOffset: 0 };
    else if (s > state.startSec && s < state.endSec) drag = { kind: 'move', grabOffset: s - state.startSec };
    else {
      // jump the window to the tap point
      const len = state.endSec - state.startSec;
      state.startSec = Math.max(0, Math.min(durationSec - len, s - len / 2));
      state.endSec = state.startSec + len;
      redraw();
      onChange(state);
      drag = { kind: 'move', grabOffset: s - state.startSec };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = secAt(e.clientX);
    const len = state.endSec - state.startSec;
    if (drag.kind === 'move') {
      state.startSec = Math.max(0, Math.min(durationSec - len, s - drag.grabOffset));
      state.endSec = state.startSec + len;
    } else if (drag.kind === 'start') {
      state.startSec = Math.max(0, Math.min(state.endSec - 0.5, Math.max(s, state.endSec - MAX_SECONDS)));
    } else {
      state.endSec = Math.min(durationSec, Math.max(state.startSec + 0.5, Math.min(s, state.startSec + MAX_SECONDS)));
    }
    redraw();
    onChange(state);
  });

  const release = () => {
    drag = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  return state;
}
