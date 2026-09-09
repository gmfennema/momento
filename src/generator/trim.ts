// Draggable trim window over the waveform canvas: pick which ≤10s of a longer
// clip goes on the card. Dragging inside the window moves it; dragging near an
// edge resizes it.

import { drawWaveform, MAX_SECONDS, PCM_SAMPLE_RATE } from '../lib/audio';

export interface TrimState {
  startSec: number;
  endSec: number;
}

export interface TrimHandle {
  /** Live state — the same object handed to onChange. */
  state: TrimState;
  /** Move the window programmatically (the tier tiles' "trim to fit" action).
   * Clamps to the clip and redraws, then reports through onChange. */
  set(startSec: number, endSec: number): void;
}

export function attachTrim(
  canvas: HTMLCanvasElement,
  pcm: Int16Array,
  onChange: (t: TrimState) => void,
): TrimHandle {
  const durationSec = pcm.length / PCM_SAMPLE_RATE;
  const state: TrimState = { startSec: 0, endSec: Math.min(durationSec, MAX_SECONDS) };

  const redraw = () => drawWaveform(canvas, pcm, PCM_SAMPLE_RATE, [state.startSec, state.endSec]);
  redraw();

  const set = (startSec: number, endSec: number): void => {
    const len = Math.max(0.1, Math.min(MAX_SECONDS, durationSec, endSec - startSec));
    state.startSec = Math.max(0, Math.min(durationSec - len, startSec));
    state.endSec = state.startSec + len;
    redraw();
    onChange(state);
  };

  const secAt = (clientX: number): number => {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(durationSec, ((clientX - rect.left) / rect.width) * durationSec));
  };

  type Drag = { kind: 'move' | 'start' | 'end'; grabOffset: number } | null;
  let drag: Drag = null;
  const EDGE_SEC = durationSec * 0.03;
  // Dragging is meaningful whenever the *selection* is shorter than the clip —
  // which a short clip can also become, once a tier tile trims it to fit.
  const draggable = (): boolean => state.endSec - state.startSec < durationSec - 1e-6;

  canvas.addEventListener('pointerdown', (e) => {
    if (!draggable()) return;
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

  return { state, set };
}
