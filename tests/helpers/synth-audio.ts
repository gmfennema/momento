// Speech-band synthetic PCM for tests: AM-modulated tone bursts with a moving
// fundamental, 8 kHz mono s16le — enough structure for Codec2 to chew on.

export function synthPcm(seconds: number, sampleRate = 8000): Int16Array {
  const n = Math.round(seconds * sampleRate);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = 120 + 60 * Math.sin(2 * Math.PI * 0.4 * t);
    const carrier =
      Math.sin(2 * Math.PI * f0 * t) +
      0.5 * Math.sin(2 * Math.PI * f0 * 2 * t) +
      0.25 * Math.sin(2 * Math.PI * f0 * 3.1 * t);
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 2.5 * t)) ** 0.5;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(9000 * carrier * envelope)));
  }
  return pcm;
}

export function rmsEnergy(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / pcm.length);
}
