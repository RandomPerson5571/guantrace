export const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
export const MAX_SAMPLES = 100_000;
export const MAX_GAP_S = 0.1;
export const SYSID_TAG = "[SYSID],";

export type Test = "quasistatic" | "dynamic" | "validation";
export type Direction = "forward" | "reverse";
export type Mode = "linear" | "angular";
export type Unit = "m" | "rad";

export interface Sample {
  runId: string;
  test: Test;
  direction: Direction;
  mode: Mode;
  channel: string;
  unit: Unit;
  time: number;
  voltage: number;
  commandVoltage?: number;
  position?: number;
  velocity: number;
  targetVelocity?: number;
  targetPosition?: number;
  battery?: number;
  gyro?: number;
  gyroRate?: number;
  current?: number;
  motorVelocities?: number[];
  clock: "run" | "robot";
}

export interface Run {
  key: string;
  samples: Sample[];
  excluded: boolean;
}

export function runKey(sample: Sample): string {
  return JSON.stringify([sample.runId, sample.mode, sample.test, sample.direction]);
}

export interface FieldPose {
  time: number;
  x: number;
  y: number;
  heading: number;
}

export class Capture {
  readonly poses: FieldPose[] = [];
  readonly runs = new Map<string, Run>();
  readonly units = new Map<string, Unit>();
  count = 0;
  readonly #lastTimes = new Map<string, number>();

  append(samples: Sample[]): void {
    if (this.count + samples.length > MAX_SAMPLES)
      throw new Error("Capture reached 100,000 channel samples. Start a new capture.");
    const last = new Map<string, number>();
    const units = new Map<string, Unit>();
    for (const sample of samples) {
      const key = runKey(sample);
      const channelKey = JSON.stringify([key, sample.channel]);
      const previous = last.get(channelKey) ?? this.#lastTimes.get(channelKey);
      if (previous !== undefined && sample.time <= previous)
        throw new Error(`Time must increase for ${sample.channel} in run ${sample.runId}. Use a new run ID after a reset.`);
      const unit = units.get(sample.channel) ?? this.units.get(sample.channel);
      if (unit !== undefined && unit !== sample.unit)
        throw new Error(`Mixed units for ${sample.channel}.`);
      units.set(sample.channel, sample.unit);
      last.set(channelKey, sample.time);
    }
    for (const sample of samples) {
      const key = runKey(sample);
      let run = this.runs.get(key);
      if (!run) {
        run = { key, samples: [], excluded: false };
        this.runs.set(key, run);
      }
      run.samples.push(sample);
    }
    for (const [key, time] of last) this.#lastTimes.set(key, time);
    for (const [channel, unit] of units) this.units.set(channel, unit);
    this.count += samples.length;
  }
}

function number(value: unknown, field: string): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n))
    throw new Error(`Provide a finite ${field}.`);
  return n;
}

function optional(value: unknown, field: string): number | undefined {
  return value === undefined || value === "" ? undefined : number(value, field);
}

function test(value: unknown): Test {
  if (value === "quasistatic" || value === "dynamic" || value === "validation") return value;
  throw new Error("Use quasistatic, dynamic, or validation for test.");
}

function direction(value: unknown): Direction {
  if (value === "forward" || value === "reverse") return value;
  throw new Error("Use forward or reverse for direction.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a sample object.");
  return value as Record<string, unknown>;
}

function applied(value: unknown): number {
  const volts = number(value, "applied voltage");
  if (Math.abs(volts) > 16) throw new Error("Applied voltage must be in volts.");
  return volts;
}

function time(value: unknown): number {
  const seconds = number(value, "timestamp in seconds");
  if (seconds < 0) throw new Error("Timestamp must be nonnegative.");
  return seconds;
}

function id(value: unknown): string {
  if ((typeof value !== "string" && !Number.isSafeInteger(value)) ||
      !/^[\w.-]{1,64}$/.test(String(value)))
    throw new Error("Provide a run ID using letters, digits, dots, underscores, or hyphens.");
  return String(value);
}

export function parseRobotSample(value: unknown, pros = false): Sample[] {
  const row = record(value);
  const mode = row.mode ?? "linear";
  if (mode !== "linear" && mode !== "angular") throw new Error("Use linear or angular for mode.");
  const battery = optional(row.batt, "battery voltage");
  if ((pros && battery === undefined) || (battery !== undefined && (battery <= 0 || battery > 16))) throw new Error("Battery voltage must be positive and in volts.");
  const gyro = optional(row.gyro, "gyro heading in radians");
  const gyroRate = optional(row.gyroRate, "gyro rate in rad/s");
  if (mode === "angular" && (gyro === undefined || gyroRate === undefined))
    throw new Error("Angular samples require gyro and gyroRate.");
  const shared = {
    runId: id(row.runId), mode: mode as Mode, test: test(row.test), direction: direction(row.direction),
    time: time(row.t), battery, gyro, gyroRate, clock: "robot" as const, unit: "m" as const,
  };
  return (["L", "R"] as const).map(side => {
    const volts = row[`v${side}`];
    const duty = volts === undefined ? number(row[`duty${side}`], "duty cycle") : undefined;
    if (duty !== undefined && battery === undefined) throw new Error("Duty cycle requires battery voltage.");
    if (duty !== undefined && Math.abs(duty) > 1) throw new Error("Duty cycle must be between -1 and 1.");
    const motors = row[`motorVel${side}`];
    if (motors !== undefined && (!Array.isArray(motors) || motors.length > 16))
      throw new Error("Per-motor velocity must be an array of up to 16 values.");
    return {
      ...shared, channel: side === "L" ? "drive-left" : "drive-right",
      voltage: applied(duty === undefined ? volts : duty * battery!),
      commandVoltage: optional(row[`command${side}`], "command voltage"),
      position: pros ? number(row[`pos${side}`], "wheel position") : optional(row[`pos${side}`], "wheel position"),
      velocity: number(row[`vel${side}`], "wheel velocity"),
      targetVelocity: optional(row[`targetVel${side}`], "target velocity"),
      targetPosition: optional(row[`targetPos${side}`], "target position"),
      current: optional(row[`current${side}`], "motor current"),
      motorVelocities: motors?.map(value => number(value, "per-motor velocity")),
    };
  });
}

export function parseBatch(line: string): Sample[] {
  if (line.length > 64 * 1024) throw new Error("SysId batch is too large.");
  const pros = line.startsWith(SYSID_TAG);
  const payload: unknown = JSON.parse(pros ? line.slice(SYSID_TAG.length) : line);
  const batch = Array.isArray(payload) ? payload : [payload];
  if (!batch.length || batch.length > 128) throw new Error("Send 1–128 samples per batch.");
  return batch.flatMap(value => parseRobotSample(value, pros));
}

const pairedFields = [
  "test", "direction", "elapsed_s", "left_applied_volts", "left_position_m", "left_velocity_mps",
  "right_applied_volts", "right_position_m", "right_velocity_mps",
];
const namedFields = ["run_id", "test", "direction", "time_s", "motor", "units", "voltage", "position", "velocity"];
const unitScale: Record<string, number> = { m: 1, in: 0.0254, rad: 1, deg: Math.PI / 180 };

function parseCsv(lines: string[]): Sample[] {
  const headers = lines[0].split(",").map(value => value.trim());
  const paired = pairedFields.every(field => headers.includes(field));
  if (!paired && !namedFields.every(field => headers.includes(field)))
    throw new Error("Choose a guanid CSV with applied voltage, position, velocity, and test metadata.");
  if (new Set(headers).size !== headers.length) throw new Error("CSV has duplicate column names.");
  const samples: Sample[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    try {
      const fields = line.split(",").map(value => value.trim());
      if (fields.length !== headers.length) throw new Error("Column count differs from the header.");
      const row = Object.fromEntries(headers.map((name, i) => [name, fields[i]]));
      const shared = {
        runId: id(row.run_id ?? "0"), test: test(row.test), direction: direction(row.direction),
        time: time(row[paired ? "elapsed_s" : "time_s"]), mode: "linear" as const,
        clock: "run" as const,
      };
      if (paired) {
        for (const side of ["left", "right"]) {
          samples.push({
            ...shared, channel: `drive-${side}`, unit: "m",
            voltage: applied(row[`${side}_applied_volts`]),
            position: number(row[`${side}_position_m`], "wheel position"),
            velocity: number(row[`${side}_velocity_mps`], "wheel velocity"),
            targetVelocity: optional(row[`${side}_target_velocity_mps`], "target velocity"),
            targetPosition: optional(row[`${side}_target_position_m`], "target position"),
            battery: optional(row.battery_volts, "battery voltage"),
          });
        }
      } else {
        const channel = id(row.motor);
        const scale = Object.hasOwn(unitScale, row.units) ? unitScale[row.units] : undefined;
        if (scale === undefined) throw new Error("Use m, in, rad, or deg for units.");
        samples.push({
          ...shared, channel: channel === "left" || channel === "right" ? `drive-${channel}` : channel, unit: row.units === "m" || row.units === "in" ? "m" : "rad",
          voltage: applied(row.voltage), position: number(row.position, "position") * scale,
          velocity: number(row.velocity, "velocity") * scale,
        });
      }
      if (samples.length > MAX_SAMPLES) throw new Error("Capture exceeds 100,000 channel samples.");
    } catch (error) {
      throw new Error(`CSV row ${index + 1}. ${(error as Error).message}`);
    }
  }
  return samples;
}

export function parseCapture(text: string): Capture {
  if (text.length > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds 32 MB.");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Capture is empty.");
  const capture = new Capture();
  if (/^(?:\[|\{)/.test(lines[0])) {
    for (const [index, line] of lines.entries()) {
      try {
        if (line.startsWith('{"fieldPose":')) {
          const { fieldPose } = JSON.parse(line);
          if (!Array.isArray(fieldPose) || fieldPose.length !== 4 || capture.poses.length >= MAX_SAMPLES)
            throw new Error("Invalid field pose record.");
          capture.poses.push({
            time: time(fieldPose[0]), x: number(fieldPose[1], "pose x"),
            y: number(fieldPose[2], "pose y"), heading: number(fieldPose[3], "pose heading"),
          });
        } else if (line.startsWith('{"excludedRun":')) {
          const run = capture.runs.get(JSON.parse(line).excludedRun);
          if (!run) throw new Error("Excluded run is missing.");
          run.excluded = true;
        } else capture.append(parseBatch(line));
      } catch (error) {
        throw new Error(`Telemetry line ${index + 1}. ${(error as Error).message}`);
      }
    }
  } else {
    capture.append(parseCsv(lines));
  }
  if (!capture.count) throw new Error("Capture contains no samples.");
  return capture;
}

export function runHealth(run: Run): { hz: number | null; sag: number | null; gaps: number } {
  const first = run.samples[0].channel;
  const samples = run.samples.filter(row => row.channel === first);
  const duration = samples[samples.length - 1].time - samples[0].time;
  let gaps = 0;
  let peak = -Infinity;
  let sag: number | null = null;
  for (const [index, row] of samples.entries()) {
    if (index && row.time - samples[index - 1].time > MAX_GAP_S) gaps++;
    if (row.battery !== undefined) {
      peak = Math.max(peak, row.battery);
      sag = Math.max(sag ?? 0, peak - row.battery);
    }
  }
  return { hz: duration > 0 ? (samples.length - 1) / duration : null, sag, gaps };
}
