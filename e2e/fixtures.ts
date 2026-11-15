// Minimal WAV fixture: N seconds of 8kHz tone bursts, built in-test.
export function wavFixture(seconds = 3): Buffer {
  const sr = 8000;
  const n = sr * seconds;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = Math.round(9000 * Math.sin(2 * Math.PI * 200 * t) * Math.max(0, Math.sin(2 * Math.PI * 2 * t)));
    data.writeInt16LE(v, 44 + i * 2);
  }
  return data;
}
