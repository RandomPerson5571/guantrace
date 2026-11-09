import { Capture, MAX_CAPTURE_BYTES, SYSID_TAG, parseRobotSample, runKey, type Run } from "./capture";

export const DRIVE_LAB_TAG = "GT1,";
const wheelTag = SYSID_TAG + "GT1W,";
const record = /^GT1,(\d{1,10}),(\d{1,10}),([\w.-]{1,47}),(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const wheelTopic = /^sysid\.(left|right)\.(run_id|test|direction|time_s|command_volts|volts|position_m|mps)$/;
const sharedFields = ["run_id", "test", "direction", "time_s"];
const requiredFields = [...sharedFields, "volts", "position_m", "mps"];
const serialFields = [...sharedFields, "command_volts", "volts", "position_m", "mps"];
const uint32Max = 0xffffffff;
// DriveLab publishes battery voltage once a second.
const maxBatteryAgeMs = 1500;

type Side = "left" | "right";
interface WheelSample {
  stamp: number;
  fields: Map<string, number>;
}

export function isDriveLabRecord(line: string): boolean {
  return line.startsWith(DRIVE_LAB_TAG) || line.startsWith(SYSID_TAG + DRIVE_LAB_TAG) ||
    line.startsWith(wheelTag);
}

export class DriveLabCapture {
  readonly capture = new Capture();
  readonly #wheels = new Map<Side, WheelSample>();
  #battery: { stamp: number; volts: number } | undefined;
  #profile: number | undefined;
  #active: Run | undefined;
  #lastTimeMs: number | undefined;

  // Returns true for recognized records so a live capture can save just its
  // SysId inputs. The other Guanlog channels continue to be available in GT1.
  receive(line: string): boolean {
    if (line.startsWith(wheelTag)) {
      const [stampText, wheel, ...fields] = line.slice(wheelTag.length).split(",");
      const stamp = Number(stampText);
      if (!/^\d{1,10}$/.test(stampText) || stamp > uint32Max ||
          (wheel !== "L" && wheel !== "R") || fields.length !== serialFields.length ||
          fields.some(field => !field.trim() || !Number.isFinite(Number(field)))) return false;
      const side = wheel === "L" ? "left" : "right";
      for (const [index, field] of serialFields.entries())
        this.receiveWheel(side, field, stamp, Number(fields[index]));
      return true;
    }
    const match = record.exec(line.startsWith(SYSID_TAG) ? line.slice(SYSID_TAG.length) : line);
    if (!match) return false;
    const [, time, sequence, topic, raw] = match;
    const stamp = Number(time);
    const value = Number(raw);
    if (stamp > uint32Max || Number(sequence) > uint32Max || !Number.isFinite(value)) return false;

    if (topic === "robot.battery_volts") {
      if (value > 0 && value <= 16) this.#battery = { stamp, volts: value };
    } else if (topic === "sysid.session_id" || topic === "sysid.profile" ||
               (topic === "sysid.result" && value >= 1 && value <= 4)) {
      this.#wheels.clear();
      this.#active = undefined;
      this.#profile = topic === "sysid.profile" ? value : undefined;
    } else if (topic === "sysid.completed_profiles") {
      if (this.#active && this.#profile === value) this.#active.excluded = false;
      this.#active = undefined;
      this.#profile = undefined;
      this.#wheels.clear();
    } else if (topic !== "sysid.result") {
      const wheel = wheelTopic.exec(topic);
      if (!wheel) return false;
      this.receiveWheel(wheel[1] as Side, wheel[2], stamp, value);
    }
    return true;
  }

  private receiveWheel(side: Side, field: string, stamp: number, value: number): void {
    let wheel = this.#wheels.get(side);
    if (!wheel || wheel.stamp !== stamp || field === "run_id") {
      wheel = { stamp, fields: new Map() };
      this.#wheels.set(side, wheel);
    }
    wheel.fields.set(field, value);
    if (field !== "mps") return;

    const left = this.#wheels.get("left");
    const right = this.#wheels.get("right");
    if (!left || !right) return;
    const l = left.fields;
    const r = right.fields;
    // The sides can have different millis() stamps. GuanID gives them the
    // same run ID, test, direction and elapsed time for one acquisition.
    if (requiredFields.some(key => !l.has(key) || !r.has(key)) ||
        sharedFields.some(key => l.get(key) !== r.get(key))) return;
    this.#wheels.clear();

    const id = l.get("run_id")!;
    const test = l.get("test");
    const direction = l.get("direction");
    if (!Number.isInteger(id) || id < 0 || id > uint32Max || l.get("time_s")! < 0 ||
        (test !== 0 && test !== 1) || (direction !== 1 && direction !== -1) ||
        Math.abs(l.get("volts")!) > 16 || Math.abs(r.get("volts")!) > 16) return;
    const expectedProfile = test * 2 + (direction === 1 ? 1 : 2);
    if (this.#profile !== undefined && this.#profile !== expectedProfile) return;
    // Unwrap the 32-bit uptime clock without substituting host receive time.
    const last = this.#lastTimeMs;
    const period = uint32Max + 1;
    const time = last === undefined ? left.stamp :
      left.stamp + Math.round((last - left.stamp) / period) * period;
    if (last !== undefined && time <= last) return;
    const batteryAge = this.#battery ? (left.stamp - this.#battery.stamp) >>> 0 : Infinity;
    const samples = parseRobotSample({
      runId: `drive-lab-${id}`,
      test: test === 0 ? "quasistatic" : "dynamic",
      direction: direction === 1 ? "forward" : "reverse",
      t: time / 1000,
      batt: batteryAge <= maxBatteryAgeMs ? this.#battery?.volts : undefined,
      vL: l.get("volts"), posL: l.get("position_m"), velL: l.get("mps"),
      vR: r.get("volts"), posR: r.get("position_m"), velR: r.get("mps"),
      commandL: l.get("command_volts"), commandR: r.get("command_volts"),
    });
    const key = runKey(samples[0]);
    this.capture.append(samples);
    this.#lastTimeMs = time;
    const run = this.capture.runs.get(key)!;
    if (this.#active !== run) {
      run.excluded = true;
      this.#active = run;
    }
  }
}

export function parseDriveLabCapture(text: string): Capture {
  if (text.length > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds 32 MB.");
  const driveLab = new DriveLabCapture();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) driveLab.receive(line.trim());
  if (!driveLab.capture.count) throw new Error("No complete DriveLab wheel samples found.");
  return driveLab.capture;
}
