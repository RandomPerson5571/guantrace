// WPILib Data Log file format, version 1. https://github.com/wpilibsuite/allwpilib/blob/v2026.2.2/wpiutil/doc/datalog.adoc
export interface SignalEntry { name: string; type: string }
export type SignalValue = number | string | number[];
export interface SignalEvent { name: string; us: number; value: SignalValue }
export const MAX_WPILOG_BYTES = 128 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function supportedType(type: string): boolean {
  return ["double", "float", "int64", "int", "string", "double[]", "float[]", "struct:Pose2d"].includes(type);
}

function decode(type: string, view: DataView): SignalValue | undefined {
  const size = view.byteLength;
  if (type === "double" && size === 8) return view.getFloat64(0, true);
  if (type === "float" && size === 4) return view.getFloat32(0, true);
  if (type === "int64" && size === 8) return Number(view.getBigInt64(0, true));
  if (type === "string") return utf8.decode(view);
  if (type === "struct:Pose2d" && size === 24)
    return [view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)];
  if (type === "double[]" && size === 24)
    return [view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)];
  if (type === "float[]" && size === 12)
    return [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)];
  if (supportedType(type)) throw new Error(`Invalid payload for WPILOG type ${type}.`);
}

export class WpiLog {
  readonly #data: DataView;
  readonly #start: number;
  readonly entries: SignalEntry[];

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength > MAX_WPILOG_BYTES) throw new Error("WPILOG exceeds 128 MB.");
    this.#data = new DataView(buffer);
    if (buffer.byteLength < 12 || utf8.decode(new Uint8Array(buffer, 0, 6)) !== "WPILOG")
      throw new Error("File is missing the WPILOG header.");
    if (this.#data.getUint16(6, true) !== 0x0100) throw new Error("Expected WPILOG version 1.0.");
    this.#start = 12 + this.#data.getUint32(8, true);
    if (this.#start > buffer.byteLength) throw new Error("WPILOG header is truncated.");
    const directory = new Map<string, SignalEntry>();
    this.scan(entry => {
      if (directory.size >= 10_000 && !directory.has(entry.name))
        throw new Error("WPILOG contains more than 10,000 entries.");
      directory.set(entry.name, entry);
    });
    this.entries = [...directory.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  read(names: Set<string>, receive: (event: SignalEvent) => void): void {
    const directory = new Map(this.entries.map(entry => [entry.name, entry]));
    for (const name of names) if (!directory.has(name)) throw new Error(`WPILOG is missing ${name}.`);
    this.scan(undefined, (entry, us, payload) => {
      if (!names.has(entry.name)) return;
      const value = decode(entry.type, payload);
      if (value !== undefined) receive({ name: entry.name, us, value });
    });
  }

  private scan(onEntry?: (entry: SignalEntry) => void,
    onData?: (entry: SignalEntry, us: number, view: DataView) => void): void {
    const data = this.#data;
    const active = new Map<number, SignalEntry>();
    let offset = this.#start;
    const uint = (bytes: number) => {
      let value = 0;
      for (let i = 0; i < bytes; i++) value += data.getUint8(offset++) * 2 ** (8 * i);
      if (!Number.isSafeInteger(value)) throw new Error("WPILOG timestamp exceeds supported precision.");
      return value;
    };
    while (offset < data.byteLength) {
      const header = data.getUint8(offset++);
      const idBytes = (header & 3) + 1;
      const sizeBytes = ((header >> 2) & 3) + 1;
      const timeBytes = ((header >> 4) & 7) + 1;
      if (header & 0x80 || offset + idBytes + sizeBytes + timeBytes > data.byteLength)
        throw new Error("WPILOG record header is invalid or truncated.");
      const id = uint(idBytes);
      const size = uint(sizeBytes);
      const us = uint(timeBytes);
      const end = offset + size;
      if (end > data.byteLength) throw new Error("WPILOG record is truncated.");
      if (id === 0) {
        if (size < 5) throw new Error("WPILOG control record is truncated.");
        const type = data.getUint8(offset++);
        const target = uint(4);
        const string = () => {
          if (offset + 4 > end) throw new Error("WPILOG control string is truncated.");
          const length = uint(4);
          if (offset + length > end) throw new Error("WPILOG control string is truncated.");
          const value = utf8.decode(new Uint8Array(data.buffer, offset, length));
          offset += length;
          return value;
        };
        if (type === 0) {
          const entry = { name: string(), type: string() };
          string(); // metadata
          active.set(target, entry);
          onEntry?.(entry);
        } else if (type === 1) {
          active.delete(target);
        } else if (type === 2) {
          string();
        }
      } else {
        const entry = active.get(id);
        if (entry && onData) onData(entry, us, new DataView(data.buffer, offset, size));
      }
      offset = end;
    }
  }
}
