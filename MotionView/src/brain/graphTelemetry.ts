export const kinds: Record<string, string> = {
  motor: "Motor", imu: "Inertial sensor", rotation: "Rotation sensor",
  distance: "Distance sensor", optical: "Optical sensor", gps: "GPS",
  vision: "Vision sensor", "ai-vision": "AI Vision sensor", adi: "ADI expander",
  radio: "Radio", serial: "Serial device",
};
export const metrics = {
  rpm: { label: "Velocity", unit: "RPM", color: "#8bb8ff" },
  power_w: { label: "Power draw", unit: "W", color: "#ffbf7b" },
  rotation_deg: { label: "Rotation", unit: "°", color: "#8bb8ff" },
  position_deg: { label: "Position", unit: "°", color: "#8bb8ff" },
  distance_mm: { label: "Distance", unit: "mm", color: "#8bb8ff" },
  hue_deg: { label: "Hue", unit: "°", color: "#8bb8ff" },
  heading_deg: { label: "Heading", unit: "°", color: "#8bb8ff" },
};
export type Metric = keyof typeof metrics;
export const deviceMetrics: Partial<Record<string, readonly Metric[]>> = {
  motor: ["rpm", "power_w"], imu: ["rotation_deg"], rotation: ["position_deg"],
  distance: ["distance_mm"], optical: ["hue_deg"], gps: ["heading_deg"],
};
export const maxSamples = 1200;
export const graphPrefix = "brain-graph-";
export const graphRequest = "brain-graph-request";
export const graphUpdate = "brain-graph-update";

export type Point = { x: number; y: number };
export type GraphRequest = {
  key: string;
  sequence: number;
  session: string;
  after: Partial<Record<Metric, number>>;
};
export type GraphUpdate = {
  key: string;
  sequence: number;
  session: string;
  online: boolean;
  signals: Partial<Record<Metric, { points: Point[]; recent: boolean }>>;
};

export function graphDevice(key: string) {
  const match = /^([a-z-]+):(\d{1,2})$/.exec(key);
  if (!match) return null;
  const [, kind, portText] = match;
  const port = Number(portText);
  if (!Object.hasOwn(kinds, kind) || port < 1 || port > 21) return null;
  return { name: kinds[kind], port, metrics: deviceMetrics[kind] ?? [] };
}

/** Reconstruct suppressed zeros only between confirmed, adjacent heartbeats. */
export function appendGraphPoint(points: Point[], point: Point): void {
  const last = points.at(-1);
  if (last && point.x <= last.x) return;
  if (last?.y === 0 && point.y === 0 && point.x - last.x <= 0.7) {
    for (let x = last.x + 0.1; x < point.x - 0.001; x += 0.1) {
      points.push({ x, y: 0 });
    }
  }
  points.push(point);
  if (points.length > maxSamples) points.splice(0, points.length - maxSamples);
}
