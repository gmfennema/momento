// Mic capture via MediaRecorder. We don't force a mimeType — whatever the
// engine records, its own decodeAudioData can read back. Hard stop at 10.5s;
// the trim step finalizes to ≤10.0s.

export interface RecorderHandle {
  stop(): void;
  blob: Promise<Blob>;
}

export const RECORD_LIMIT_MS = 10_500;

export async function startRecording(onTick?: (elapsedMs: number) => void): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // No far-end signal to cancel when recording a memo — echo cancellation
      // can only duck/distort the voice, so keep it off.
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const rec = new MediaRecorder(stream);
  const parts: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) parts.push(e.data);
  };

  const started = Date.now();
  const tick = onTick
    ? window.setInterval(() => onTick(Date.now() - started), 100)
    : 0;

  const blob = new Promise<Blob>((resolve) => {
    rec.onstop = () => {
      if (tick) clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(parts, { type: rec.mimeType || 'audio/webm' }));
    };
  });

  const timeout = window.setTimeout(() => {
    if (rec.state !== 'inactive') rec.stop();
  }, RECORD_LIMIT_MS);

  rec.start();

  return {
    stop() {
      clearTimeout(timeout);
      if (rec.state !== 'inactive') rec.stop();
    },
    blob,
  };
}
