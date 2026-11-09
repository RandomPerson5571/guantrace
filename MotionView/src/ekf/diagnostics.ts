export interface Innovation {
  time: number; epoch: number; sequence: number; source: number;
  residual: number; variance: number; accepted: boolean; gain: number[];
}
const uint = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
export function parseInnovation(line: string): Innovation | null {
  const fields = line.trim().split(",");
  if (fields.length !== 14 || fields[0] !== "GTE1" || fields.slice(1).some(v => !v.trim())) return null;
  const [time, epoch, sequence, source, residual, variance, accepted, ...gain] = fields.slice(1).map(Number);
  if (![time, epoch, sequence].every(uint) || !Number.isInteger(source) || source < 0 || source > 23 ||
      ![residual, variance, ...gain].every(Number.isFinite) || variance <= 0 ||
      !Number.isFinite(residual * residual / variance) || (accepted !== 0 && accepted !== 1)) return null;
  return { time, epoch, sequence, source, residual, variance, accepted: accepted === 1, gain };
}
export function sourceName(source: number): string {
  return source === 0 ? "IMU heading (rad)" : source === 1 ? "Gyro bias (rad/s)" : `Distance · port ${source - 2} (m)`;
}
// Lanczos log-gamma and regularized lower incomplete gamma. Invert by bisection.
function logGamma(z: number): number {
  const c = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  z -= 1;
  let x = 0.99999999999980993;
  c.forEach((v, i) => x += v / (z + i + 1));
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const scale = Math.exp(a * Math.log(x) - x - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let i = 1; i < 10000; i++) {
      term *= x / (a + i); sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * scale;
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return 1 - scale * h;
}
export function chiSquareQuantile(p: number, degrees: number): number {
  if (!(p > 0 && p < 1) || !Number.isInteger(degrees) || degrees < 1) throw new Error("Invalid chi-square parameters");
  let lo = 0, hi = Math.max(1, degrees);
  while (gammaP(degrees / 2, hi / 2) < p) hi *= 2;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(degrees / 2, mid / 2) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
export function consistency(rows: readonly Innovation[]) {
  if (!rows.length) return null;
  const n = rows.length;
  const normalized = rows.map(row => row.residual / Math.sqrt(row.variance));
  const mean = normalized.reduce((a, b) => a + b / n, 0);
  const centered = normalized.map(v => v - mean);
  const energy = centered.reduce((sum, v) => sum + v * v, 0);
  const acf = Array.from({ length: Math.min(40, n - 1) }, (_, index) => {
    const lag = index + 1;
    return { x: lag, y: energy > 1e-20 ? centered.slice(lag).reduce((sum, v, i) => sum + v * centered[i], 0) / energy : null };
  });
  const lower = chiSquareQuantile(0.025, 1), upper = chiSquareQuantile(0.975, 1);
  const nis = normalized.map(v => v * v);
  return {
    count: n, meanResidual: rows.reduce((sum, row) => sum + row.residual / n, 0),
    meanNormalized: mean, meanNis: nis.reduce((a, b) => a + b / n, 0),
    lower, upper, averageLower: chiSquareQuantile(0.025, n) / n, averageUpper: chiSquareQuantile(0.975, n) / n,
    coverage: nis.filter(v => v >= lower && v <= upper).length / n,
    threeSigma: normalized.filter(v => Math.abs(v) <= 3).length / n,
    rejected: rows.filter(row => !row.accepted).length,
    acf, acfBound: 1.96 / Math.sqrt(n),
  };
}
