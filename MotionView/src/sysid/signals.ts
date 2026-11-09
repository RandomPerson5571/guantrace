import { Capture, MAX_SAMPLES, parseRobotSample, type Direction, type Mode, type Test } from "./capture";
import type { SignalEvent } from "./wpilog";

export const fields = [
  ["vL", "Left applied voltage (V)", "number", true],
  ["vR", "Right applied voltage (V)", "number", true],
  ["velL", "Left velocity (m/s)", "number", true],
  ["velR", "Right velocity (m/s)", "number", true],
  ["posL", "Left position (m)", "number", false],
  ["posR", "Right position (m)", "number", false],
  ["targetVelL", "Left target velocity (m/s)", "number", false],
  ["targetVelR", "Right target velocity (m/s)", "number", false],
  ["batt", "Battery voltage (V)", "number", false],
  ["gyro", "Gyro heading (rad)", "number", false],
  ["gyroRate", "Gyro rate (rad/s)", "number", false],
  ["state", "SysId test state", "state", false],
  ["pose", "Field pose (m, m, rad)", "pose", false],
] as const;

export type SignalKey = typeof fields[number][0];
export type Mapping = Partial<Record<SignalKey, string>>;
export const requiredSignals = fields.filter(field => field[3]);
const tolerance = 4_000;
const reorderWindow = 100_000;
const maxSignalEvents = 750_000;

export function fieldAccepts(kind: "number" | "state" | "pose", type: string): boolean {
  if (kind === "number") return ["double", "float", "int", "int64"].includes(type);
  if (kind === "state") return type === "string";
  return ["double[]", "float[]", "struct:Pose2d"].includes(type);
}

function lowerBound(events: SignalEvent[], time: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].us < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function decodeState(value: string): { test: Test; direction: Direction; mode: Mode } | null {
  const state = value.toLowerCase().trim().replace(/[ _]+/g, "-");
  const match = /^(?:(linear|angular)-)?(quasistatic|dynamic|validation)-(forward|reverse)$/.exec(state);
  if (match) return {
    mode: (match[1] ?? "linear") as Mode,
    test: match[2] as Test,
    direction: match[3] as Direction,
  };
  if (state === "validation") return { mode: "linear", test: "validation", direction: "forward" };
  return null;
}

export class SignalCapture {
  readonly capture = new Capture();
  readonly lines: string[] = [];
  readonly #events = new Map<string, SignalEvent[]>();
  readonly #seen = new Set<string>();
  readonly #lastUsed = new Map<string, number>();
  #watermark = -Infinity;
  #latest = -Infinity;
  #received = 0;
  #run = 0;
  #state = "";
  #stateStart = -Infinity;
  #lastAnchor = -Infinity;
  #lastPose = -Infinity;
  skipped = 0;
  late = 0;
  unknownState = 0;

  constructor(readonly mapping: Mapping) {
    for (const [key, label] of requiredSignals) {
      if (!mapping[key]) throw new Error(`Map ${label.toLowerCase()}.`);
    }
    for (const name of Object.values(mapping)) {
      if (name) this.#events.set(name, []);
    }
  }

  get names(): Set<string> { return new Set(this.#events.keys()); }
  get missing(): string[] {
    return fields.filter(([key]) => this.mapping[key] && !this.#seen.has(this.mapping[key]!)).map(([, label]) => label);
  }

  receive(event: SignalEvent): void {
    const events = this.#events.get(event.name);
    if (!events || !Number.isSafeInteger(event.us) || event.us < 0) return;
    if (event.us <= this.#watermark) {
      this.late++;
      return;
    }
    if (++this.#received > maxSignalEvents) throw new Error("Reached the mapped signal event limit.");
    events.push(event);
    this.#seen.add(event.name);
    this.#latest = Math.max(this.#latest, event.us);
  }

  drain(final = false): void {
    const cutoff = final ? Infinity : this.#latest - reorderWindow;
    if (cutoff <= this.#watermark) return;
    for (const events of this.#events.values()) events.sort((a, b) => a.us - b.us);
    const eventsFor = (key: SignalKey) => this.#events.get(this.mapping[key] ?? "") ?? [];
    let previousState = this.#state;
    const states = eventsFor("state").filter(({ value }) => {
      const state = typeof value === "string" ? value.toLowerCase().trim() : "";
      if (state === previousState) return false;
      previousState = state;
      return true;
    });
    const anchors = eventsFor("velL");
    let stateIndex = 0;
    const at = (key: SignalKey, time: number, fresh: boolean) => {
      const events = eventsFor(key);
      const index = lowerBound(events, time - tolerance);
      let nearest: SignalEvent | undefined;
      const used = this.#lastUsed.get(key) ?? -Infinity;
      for (let i = index; i < events.length && events[i].us <= time + tolerance; i++) {
        const event = events[i];
        if (typeof event.value !== "number" || !Number.isFinite(event.value) ||
            event.us < this.#stateStart || event.us >= (states[stateIndex]?.us ?? Infinity) ||
            (fresh && event.us <= used)) continue;
        if (!nearest || Math.abs(event.us - time) < Math.abs(nearest.us - time)) nearest = event;
      }
      return nearest;
    };

    const updateState = (until: number) => {
      while (stateIndex < states.length && states[stateIndex].us <= until) {
        const { us, value } = states[stateIndex++];
        const state = typeof value === "string" ? value.toLowerCase().trim() : "";
        if (state === this.#state) continue;
        this.#state = state;
        this.#stateStart = us;
        this.#run++;
        if (state && !["none", "idle", "disabled"].includes(state) && !decodeState(state)) this.unknownState++;
      }
    };

    for (const anchor of anchors) {
      const { us } = anchor;
      if (us > cutoff) break;
      if (us <= this.#lastAnchor) continue;
      this.#lastAnchor = us;
      updateState(us);
      const state = this.mapping.state ? decodeState(this.#state) : decodeState("validation");
      if (!state) continue;
      const row: Record<string, unknown> = { ...state, runId: `mapped-${this.#run}`, t: us / 1e6 };
      const selected = new Map<SignalKey, number>();
      for (const [key, , kind, required] of fields) {
        if (kind !== "number") continue;
        const event = key === "velL" ? anchor : at(key, us, required);
        if (!event) continue;
        row[key] = event.value;
        if (required) selected.set(key, event.us);
      }
      if (selected.size !== requiredSignals.length) {
        this.skipped++;
        continue;
      }
      let samples;
      try {
        samples = parseRobotSample(row);
      } catch {
        this.skipped++;
        continue;
      }
      this.capture.append(samples);
      this.lines.push(JSON.stringify(row));
      for (const [key, us] of selected) this.#lastUsed.set(key, us);
    }
    updateState(cutoff);

    for (const { us, value } of eventsFor("pose")) {
      if (us > cutoff) break;
      if (us <= this.#lastPose || !Array.isArray(value) || value.length !== 3 ||
          !value.every(Number.isFinite)) continue;
      if (this.capture.poses.length >= MAX_SAMPLES) throw new Error("Reached the field pose limit.");
      const [x, y, heading] = value;
      this.capture.poses.push({ time: us / 1e6, x, y, heading });
      this.#lastPose = us;
    }
    for (const [name, events] of this.#events) {
      const keepFrom = lowerBound(events, name === this.mapping.state ? cutoff + 1 : cutoff - tolerance);
      if (keepFrom) events.splice(0, keepFrom);
    }
    this.#watermark = cutoff - (final ? 0 : tolerance);
  }

  diagnostic(): string {
    const missing = this.missing;
    return [
      missing.length ? `No values for ${missing.join(", ")}.` : "",
      this.skipped ? `Skipped ${this.skipped} unaligned or invalid samples.` : "",
      this.late ? `Ignored ${this.late} updates outside the alignment window.` : "",
      this.unknownState ? `Ignored ${this.unknownState} unrecognized test states.` : "",
    ].filter(Boolean).join(" ");
  }

  interrupt(): boolean {
    const last = Array.from(this.capture.runs.values()).at(-1);
    if (!last || (this.mapping.state && !decodeState(this.#state)) ||
        last.samples[0].runId !== `mapped-${this.#run}`) return false;
    last.excluded = true;
    return true;
  }

  exportLines(): string[] {
    const poses = this.capture.poses.map(pose =>
      JSON.stringify({ fieldPose: [pose.time, pose.x, pose.y, pose.heading] }));
    const exclusions = [...this.capture.runs.values()].filter(run => run.excluded)
      .map(run => JSON.stringify({ excludedRun: run.key }));
    return [...this.lines, ...poses, ...exclusions];
  }
}
