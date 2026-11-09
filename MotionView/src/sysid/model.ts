import { MAX_GAP_S, type Run, type Sample, type Unit } from "./capture";

// The simple-motor preprocessing and scaled QR follow guanid's analysis.hpp.
// See GUANID-LICENSE.txt for the upstream copyright and license.
export interface Gains {
  kS: number;
  kV: number;
  kA: number;
}

export interface ErrorMetrics {
  count: number;
  rmse: number;
  bias: number;
  rSquared: number | null;
}

export function errorMetrics(pairs: readonly (readonly [number, number])[]): ErrorMetrics | null {
  if (!pairs.length) return null;
  const mean = pairs.reduce((sum, [measured]) => sum + measured / pairs.length, 0);
  let squaredError = 0;
  let signedError = 0;
  let variance = 0;
  for (const [measured, predicted] of pairs) {
    squaredError += (measured - predicted) ** 2;
    signedError += measured - predicted;
    variance += (measured - mean) ** 2;
  }
  if (![squaredError, signedError, variance].every(Number.isFinite)) return null;
  return {
    count: pairs.length, rmse: Math.sqrt(squaredError / pairs.length),
    bias: signedError / pairs.length,
    rSquared: variance > 1e-20 ? 1 - squaredError / variance : null,
  };
}

function leastSquares(rows: number[][], y: number[]): number[] | null {
  const n = rows[0].length;
  const q: number[][] = [];
  const r = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const scales: number[] = [];
  const qty: number[] = [];
  for (let j = 0; j < n; j++) {
    const scale = rows.reduce((norm, row) => Math.hypot(norm, row[j]), 0);
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    scales.push(scale);
    const column = rows.map(row => row[j] / scale);
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < j; k++) {
        const dot = column.reduce((sum, v, i) => sum + v * q[k][i], 0);
        r[k][j] += dot;
        for (let i = 0; i < column.length; i++) column[i] -= dot * q[k][i];
      }
    }
    const norm = column.reduce((sum, value) => Math.hypot(sum, value), 0);
    if (!(norm >= 1e-6)) return null;
    r[j][j] = norm;
    q.push(column.map(value => value / norm));
    qty.push(q[j].reduce((sum, value, i) => sum + value * y[i], 0));
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let k = j + 1; k < n; k++) qty[j] -= r[j][k] * qty[k];
    qty[j] /= r[j][j];
  }
  const result = qty.map((value, i) => value / scales[i]);
  return result.every(Number.isFinite) ? result : null;
}

export interface Diagnostic {
  sample: Sample;
  velocity: number;
  acceleration: number;
  residual: number;
}

function preprocess(rows: Sample[]): Diagnostic[] {
  const radius = 2;
  const support = radius * 2;
  if (support >= Math.floor(rows.length / 2)) return [];
  const velocity = rows.map(row => row.velocity);
  for (let i = radius; i + radius < rows.length; i++) {
    const window = rows.slice(i - radius, i + radius + 1).map(row => row.velocity);
    velocity[i] = window.sort((a, b) => a - b)[radius];
  }
  const result: Diagnostic[] = [];
  for (let i = support; i + support < rows.length; i++) {
    const center = rows[i];
    if (center.time - rows[0].time < 0.05 || Math.abs(velocity[i]) <= 0.02) continue;
    const start = i - support;
    const window = rows.slice(start, i + support + 1);
    if (window.some((row, j) => Math.abs(row.velocity) <= 0.02 ||
        Math.sign(row.velocity) !== Math.sign(velocity[i]) ||
        (j > 0 && row.time - window[j - 1].time > MAX_GAP_S))) continue;
    const x = rows.slice(i - radius, i + radius + 1).map(row => {
      const t = row.time - center.time;
      return [1, t, t * t];
    });
    const polynomial = leastSquares(x, velocity.slice(i - radius, i + radius + 1));
    if (polynomial) result.push({ sample: center, velocity: velocity[i], acceleration: polynomial[1], residual: 0 });
  }
  return result;
}

export function canSimulate(gains: Gains): boolean {
  return Object.values(gains).every(Number.isFinite) && gains.kS >= 0 && gains.kV > 0 && gains.kA > 0;
}

// Exact constant-voltage step on either side of zero, with static friction at rest.
export function stepVelocity(velocity: number, voltage: number, dt: number, gains: Gains): number {
  const { kS, kV, kA } = gains;
  const rate = kV / kA;
  const fromRest = (duration: number) => Math.abs(voltage) <= kS ? 0 :
    (voltage - Math.sign(voltage) * kS) / kV * -Math.expm1(-rate * duration);
  if (velocity === 0) return fromRest(dt);
  const steady = (voltage - Math.sign(velocity) * kS) / kV;
  const next = velocity + (steady - velocity) * -Math.expm1(-rate * dt);
  if (Math.sign(steady) === -Math.sign(velocity) && Math.sign(next) !== Math.sign(velocity)) {
    const stop = Math.log1p(-velocity / steady) / rate;
    return fromRest(Math.max(0, dt - stop));
  }
  return next;
}

export interface Prediction {
  sample: Sample;
  simulated: number | null;
}

export function simulate(rows: Sample[], gains: Gains): Prediction[] {
  let simulated: number | null = null;
  return rows.map((sample, i) => {
    if (!canSimulate(gains)) return { sample, simulated: null };
    if (i === 0) {
      simulated = sample.velocity;
    } else if (simulated !== null) {
      const previous = rows[i - 1];
      const dt = sample.time - previous.time;
      simulated = dt > 0 && dt <= MAX_GAP_S ? stepVelocity(simulated, previous.voltage, dt, gains) : null;
      if (simulated !== null && !Number.isFinite(simulated)) simulated = null;
    }
    return { sample, simulated };
  });
}

export function predictionMetrics(points: Prediction[]): { model: ErrorMetrics | null; tracking: ErrorMetrics | null } {
  const model: [number, number][] = [];
  const tracking: [number, number][] = [];
  for (const [i, { sample, simulated }] of points.entries()) {
    if (i > 0 && simulated !== null) model.push([sample.velocity, simulated]);
    if (sample.targetVelocity !== undefined) tracking.push([sample.velocity, sample.targetVelocity]);
  }
  return { model: errorMetrics(model), tracking: errorMetrics(tracking) };
}

export interface Fit {
  gains: Gains;
  unit: Unit;
  diagnostics: Diagnostic[];
  acceleration: ErrorMetrics | null;
  simulation: ErrorMetrics | null;
  warnings: string[];
}

export function fitChannel(runs: Run[], channel: string): Fit {
  const segments = runs.filter(run => !run.excluded && run.samples[0].mode === "linear" &&
    run.samples[0].test !== "validation").map(run => run.samples.filter(row => row.channel === channel));
  const diagnostics = segments.flatMap(preprocess);
  const coverage = new Set(diagnostics.map(({ sample }) => `${sample.test}-${sample.direction}`));
  if (coverage.size < 4) throw new Error("Need usable quasistatic and dynamic runs in both directions.");
  if (diagnostics.length < 12) throw new Error("Need at least 12 moving samples.");
  const coeff = leastSquares(diagnostics.map(row => [row.sample.voltage, row.velocity, Math.sign(row.velocity)]),
    diagnostics.map(row => row.acceleration));
  if (!coeff) throw new Error("The data cannot identify three gains. Check for voltage variation and acceleration.");
  const [b0, b1, b2] = coeff;
  if (!(b0 > 0)) throw new Error("Voltage-to-acceleration gain is nonpositive. Check sensor polarity and timestamps.");
  const gains = { kS: -b2 / b0, kV: -b1 / b0, kA: 1 / b0 };
  if (!Object.values(gains).every(Number.isFinite)) throw new Error("The data produced nonfinite gains.");
  const acceleration = errorMetrics(diagnostics.map(row => {
    const voltage = gains.kS * Math.sign(row.velocity) + gains.kV * row.velocity + gains.kA * row.acceleration;
    row.residual = row.sample.voltage - voltage;
    return [row.acceleration, b0 * row.sample.voltage + b1 * row.velocity + b2 * Math.sign(row.velocity)];
  }));
  const simulations = segments.map(rows => simulate(rows, gains));
  const simulation = errorMetrics(simulations.flatMap(points => points.slice(1).flatMap(point =>
    point.simulated === null ? [] : [[point.sample.velocity, point.simulated] as const])));
  const warnings: string[] = [];
  if (!canSimulate(gains)) warnings.push("Nonphysical gains. Velocity simulation is unavailable.");
  if (acceleration?.rSquared == null || acceleration.rSquared < 0.2)
    warnings.push("Low or unavailable acceleration R². Inspect noise, timing and kA.");
  if (simulation?.rSquared != null && simulation.rSquared < 0.95)
    warnings.push("Simulated velocity R² is below 0.95. Inspect the velocity overlay and voltage residuals.");
  return { gains, unit: diagnostics[0].sample.unit, diagnostics, acceleration, simulation, warnings };
}

// Ignore display metadata and run IDs so a renamed or re-exported fit run is still recognized.
export async function runFingerprint(run: Run, channel: string): Promise<string> {
  const rows = run.samples.filter(row => row.channel === channel);
  if (!rows.length) return "";
  const start = rows[0].time;
  const contents = JSON.stringify(rows.map(row => [
    (row.time - start).toFixed(6), row.voltage.toFixed(6), row.velocity.toFixed(6),
  ]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
