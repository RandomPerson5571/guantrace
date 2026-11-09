const deviceRecord = /^GT1,(\d{1,10}),(\d{1,10}),(?:drive\.motor|device\.([a-z-]+))\.(\d{1,2})\.([a-z_]+),(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

export interface DeviceReading {
  kind: string;
  port: number;
  metric: string;
  timeMs: number;
  value: number;
}

export function parseDeviceReading(line: string): DeviceReading | null {
  const match = deviceRecord.exec(line);
  if (!match) return null;
  const [, stamp, sequence, kind = "motor", portText, metric, raw] = match;
  const port = Number(portText);
  const timeMs = Number(stamp);
  const value = Number(raw);
  if (port < 1 || port > 21 || timeMs > 0xffff_ffff ||
      Number(sequence) > 0xffff_ffff || !Number.isFinite(value)) return null;
  if (match[3] === undefined && metric !== "rpm" && metric !== "power_w") return null;
  return { kind, port, metric, timeMs, value: value === 0 ? 0 : value };
}
