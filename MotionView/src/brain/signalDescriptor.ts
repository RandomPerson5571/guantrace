export interface SignalDescriptor { time: number; topic: string; kind: string; port: number; unit: string; type: string; period: number }
export function parseDescriptor(line: string): SignalDescriptor | null {
  const p = line.trim().split(",");
  if (p.length !== 8 || p[0] !== "GTD1") return null;
  const time = Number(p[1]), port = Number(p[4]), period = Number(p[7]);
  if (!/^\d{1,10}$/.test(p[1]) || time > 0xffffffff || !/^[\w.-]{1,47}$/.test(p[2]) ||
      !/^[a-z-]{1,24}$/.test(p[3]) || !/^\d{1,2}$/.test(p[4]) || port > 21 ||
      !/^[\w/°^.-]{1,24}$/.test(p[5]) || !["float64", "bool", "int32"].includes(p[6]) ||
      !/^\d{1,6}$/.test(p[7]) || period < 1 || period > 60000) return null;
  return { time, topic: p[2], kind: p[3], port, unit: p[5], type: p[6], period };
}
