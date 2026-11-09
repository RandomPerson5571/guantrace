import { parseDescriptor } from "./signalDescriptor";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invokeCommand, isTauriRuntime } from "../tauri/commands";
import { subscribeMode } from "../app/modeController";
import { requiredElement } from "../dom/elements";
import type { LiveFeature } from "../live/LiveFeature";
import type { DeviceReading } from "./deviceTelemetry";
import {
  deviceMetrics, graphDevice, graphPrefix, graphRequest, graphUpdate, kinds, appendGraphPoint,
  type GraphRequest, type GraphUpdate, type Metric, type Point,
} from "./graphTelemetry";
import "./brain.css";

const presentTimeoutMs = 3000;
const sampleTimeoutMs = 700;
type Series = { points: Point[]; receivedAt: number };
type Device = {
  name: string;
  port: number;
  seenAt: number;
  button: HTMLButtonElement;
  status: HTMLElement;
  series: Map<Metric, Series>;
};

export class BrainView {
  readonly #panel = requiredElement("brainPanel", HTMLElement);
  readonly #list = requiredElement("brainDevices", HTMLUListElement);
  readonly #empty = requiredElement("brainEmpty", HTMLElement);
  readonly #status = requiredElement("brainStatus", HTMLElement);
  readonly #error = requiredElement("brainWindowError", HTMLElement);
  readonly #stream = requiredElement("brainStream", HTMLButtonElement);
  readonly #devices = new Map<string, Device>();
  readonly #native = isTauriRuntime();
  readonly #popups = new Map<string, Window>();
  readonly #ready: Promise<unknown>;
  #session = crypto.randomUUID();
  #timer: number | undefined;
  #resetOnReading = false;
  #robotTimeMs = 0;
  readonly #descriptors = new Map<string, HTMLTableRowElement>();

  constructor(private readonly live: LiveFeature) {
    this.#ready = this.#native
      ? getCurrentWebviewWindow().listen<GraphRequest>(graphRequest, ({ payload }) => this.reply(payload))
      : Promise.resolve();
    if (!this.#native) {
      window.addEventListener("message", ({ data, source, origin }) => {
        if (origin !== location.origin || data?.type !== graphRequest || !data.request) return;
        const popup = this.#popups.get(data.request.key);
        if (popup && source === popup) this.reply(data.request, popup);
      });
    }
    this.#stream.addEventListener("click", () => {
      if (live.stream.streaming) void live.stop();
      else void live.start();
    });
    live.events.diagnosticRecord.subscribe(line => {
      const descriptor = parseDescriptor(line);
      if (!descriptor) {
        const match = /^GT1,\d+,\d+,([\w.-]+),(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(line);
        const row = match && this.#descriptors.get(match[1]);
        if (row && Number.isFinite(Number(match![2]))) row.cells[5].textContent = match![2];
        return;
      }
      this.receive({ kind: descriptor.kind, port: descriptor.port, metric: "present", timeMs: descriptor.time, value: 1 });
      const table = requiredElement("brainSignals", HTMLElement);
      let row = this.#descriptors.get(descriptor.topic);
      if (!row) {
        if (this.#descriptors.size >= 512) return;
        row = document.createElement("tr");
        this.#descriptors.set(descriptor.topic, row); table.append(row);
      }
      row.replaceChildren(...[descriptor.topic, `${descriptor.kind} / ${descriptor.port}`, descriptor.type, descriptor.unit, String(descriptor.period), row.cells[5]?.textContent || "—"].map(value => {
        const cell = document.createElement("td"); cell.textContent = value; return cell;
      }));
    });
    live.events.deviceReading.subscribe(reading => this.receive(reading));
    live.events.streamChanged.subscribe(({ current }) => {
      if (current === "starting") {
        this.#resetOnReading = true;
        this.#descriptors.clear();
        requiredElement("brainSignals", HTMLElement).replaceChildren();
      }
      this.render();
    });
    void this.#ready.catch(error => console.warn("Device graph events unavailable:", error));
    live.events.projectChanged.subscribe(() => this.render());
    subscribeMode(mode => {
      this.#panel.hidden = mode !== "brain";
      window.clearInterval(this.#timer);
      if (this.#panel.hidden) return;
      this.render();
      this.#timer = window.setInterval(() => this.render(), 250);
    });
  }

  private receive(reading: DeviceReading): void {
    const { kind, port, metric, value, timeMs } = reading;
    if (!Object.hasOwn(kinds, kind)) return;
    const supported = deviceMetrics[kind] ?? [];
    if (metric !== "present" && !supported.includes(metric as Metric)) return;
    if (this.#resetOnReading) {
      this.#resetOnReading = false;
      this.#devices.clear();
      this.#descriptors.clear();
      requiredElement("brainSignals", HTMLElement).replaceChildren();
      this.#list.replaceChildren();
      this.#session = crypto.randomUUID();
      this.#robotTimeMs = 0;
    }
    // Unwrap the robot's 32-bit clock relative to the newest reading.
    const period = 2 ** 32;
    const time = this.#robotTimeMs > 0
      ? timeMs + Math.round((this.#robotTimeMs - timeMs) / period) * period
      : timeMs;
    this.#robotTimeMs = Math.max(this.#robotTimeMs, time);
    const key = `${kind}:${port}`;
    const now = performance.now();
    const device = this.#devices.get(key) ?? this.addDevice(key, kind, port);
    device.seenAt = now;
    if (metric === "present") return;
    const signal = metric as Metric;
    let series = device.series.get(signal);
    if (!series) {
      series = { points: [], receivedAt: now };
      device.series.set(signal, series);
    }
    if (time / 1000 <= (series.points.at(-1)?.x ?? -Infinity)) return;
    series.receivedAt = now;
    appendGraphPoint(series.points, { x: time / 1000, y: value });
  }

  private addDevice(key: string, kind: string, port: number): Device {
    const name = kinds[kind];
    const item = document.createElement("li");
    const button = document.createElement("button");
    const label = document.createElement("span");
    const status = document.createElement("small");
    button.type = "button";
    button.setAttribute("aria-label", `Open ${name.toLowerCase()} on port ${port} in a new window`);
    label.textContent = name;
    status.textContent = `Port ${port}`;
    button.append(label, status);
    item.append(button);
    const device = { name, port, seenAt: 0, button, status, series: new Map<Metric, Series>() };
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await this.openGraph(key);
      } finally {
        button.disabled = false;
      }
    });
    const next = [...this.#devices.values()].sort((a, b) => a.port - b.port).find(other => other.port > port);
    this.#list.insertBefore(item, next?.button.parentElement ?? null);
    this.#devices.set(key, device);
    return device;
  }

  private async openGraph(key: string): Promise<void> {
    this.#error.hidden = true;
    try {
      if (this.#native) {
        await this.#ready;
        await invokeCommand("open_brain_graph", { key });
      } else {
        const existing = this.#popups.get(key);
        if (existing && !existing.closed) {
          existing.focus();
          return;
        }
        const url = new URL("brain-graph.html", location.href);
        url.searchParams.set("device", key);
        const popup = window.open(url, graphPrefix + key, "popup,width=900,height=650");
        if (!popup) throw new Error("Popup blocked");
        this.#popups.set(key, popup);
        popup.focus();
      }
    } catch (error) {
      console.warn("Could not open device graph:", error);
      this.#error.hidden = false;
    }
  }

  private reply(request: GraphRequest, popup?: Window): void {
    if (!request || typeof request.key !== "string" || !graphDevice(request.key) || !request.after) return;
    const device = this.#devices.get(request.key);
    const streaming = this.live.stream.streaming;
    const now = performance.now();
    const update: GraphUpdate = {
      key: request.key,
      sequence: request.sequence,
      session: this.#session,
      online: Boolean(device && streaming && now - device.seenAt < presentTimeoutMs),
      signals: {},
    };
    for (const [metric, series] of device?.series ?? []) {
      const after = request.session === this.#session ? request.after[metric] ?? -Infinity : -Infinity;
      update.signals[metric] = {
        points: series.points.filter(point => point.x > after),
        recent: streaming && now - series.receivedAt < sampleTimeoutMs,
      };
    }
    if (popup) popup.postMessage({ type: graphUpdate, update }, location.origin);
    else void emitTo(graphPrefix + request.key, graphUpdate, update).catch(() => {});
  }

  private render(): void {
    if (this.#panel.hidden) return;
    const state = this.live.stream.state;
    const streaming = state === "streaming";
    this.#stream.textContent = streaming ? "Stop stream" : "Start stream";
    this.#stream.disabled = !this.live.project.valid || state === "starting" || state === "stopping";
    const status = !this.live.project.valid ? "Set a PROS project in Settings"
      : streaming ? "Streaming"
      : state === "starting" ? "Connecting…"
      : state === "stopping" ? "Stopping…"
      : "Stream stopped";
    if (this.#status.textContent !== status) this.#status.textContent = status;
    this.#empty.hidden = this.#devices.size > 0;
    this.#empty.textContent = streaming ? "Waiting for devices…" : "Start the stream to discover devices.";
    const now = performance.now();
    for (const device of this.#devices.values()) {
      const online = streaming && now - device.seenAt < presentTimeoutMs;
      const label = `Port ${device.port} · ${online ? "Online" : "Offline"}`;
      if (device.status.textContent !== label) device.status.textContent = label;
    }
  }
}
