// Minimal power-of-two FFT for the neural bandwidth-extension pipeline.
// Iterative radix-2 complex transform plus real-input/real-output wrappers
// matching numpy's rfft/irfft conventions. Pure math — runs in node tests.
// Speed is a non-issue here: the neural net dominates the pipeline by orders
// of magnitude, so the simple complex transform is plenty.

function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tRe = re[b]! * curRe - im[b]! * curIm;
        const tIm = re[b]! * curIm + im[b]! * curRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

export interface ComplexBins {
  re: Float64Array;
  im: Float64Array;
}

/** Real-input FFT: n real samples → n/2+1 complex bins (numpy rfft). */
export function rfft(x: ArrayLike<number>, n: number): ComplexBins {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const m = Math.min(x.length, n);
  for (let i = 0; i < m; i++) re[i] = x[i]!;
  fftInPlace(re, im, false);
  const bins = n / 2 + 1;
  return { re: re.subarray(0, bins).slice(), im: im.subarray(0, bins).slice() };
}

/** Inverse of rfft: n/2+1 complex bins → n real samples (numpy irfft). */
export function irfft(bins: ComplexBins, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const half = n / 2;
  for (let k = 0; k <= half; k++) {
    re[k] = bins.re[k]!;
    im[k] = bins.im[k]!;
  }
  for (let k = 1; k < half; k++) {
    re[n - k] = bins.re[k]!;
    im[n - k] = -bins.im[k]!;
  }
  fftInPlace(re, im, true);
  return re;
}
