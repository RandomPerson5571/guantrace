import { emitTo } from "@tauri-apps/api/event";
import Chart from "chart.js/auto";
import { requiredElement } from "../dom/elements";
import { isTauriRuntime } from "../tauri/commands";
import {
  graphDevice, graphPrefix, graphRequest, graphUpdate, maxSamples, metrics,
  type GraphRequest, type GraphUpdate, type Metric, type Point,
} from "./graphTelemetry";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./brain.css";

const graphs = requiredElement("brainGraphs", HTMLElement);
const status = requiredElement("graphStatus", HTMLElement);
const title = requiredElement("graphTitle", HTMLElement);
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const native = isTauriRuntime();
const key = native ? getCurrentWebviewWindow().label.slice(graphPrefix.length)
  : new URLSearchParams(location.search).get("device") ?? "";
const device = graphDevice(key);
if (device) {
  document.title = `${device.name} · Port ${device.port}`;
  title.textContent = document.title;
  if (!device.metrics.length) status.textContent = "This device has no telemetry channels.";
  else void start(device).catch(() => { status.textContent = "Couldn’t connect to the Brain tab."; });
} else {
  status.textContent = "Device unavailable.";
}

async function start(device: NonNullable<ReturnType<typeof graphDevice>>): Promise<void> {
  const plots = new Map<Metric, { chart: Chart<"line", Point[]>; value: HTMLElement; points: Point[] }>();
  for (const metric of device.metrics) {
    const { label, unit, color } = metrics[metric];
    const panel = document.createElement("section");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    const value = document.createElement("p");
    const plot = document.createElement("div");
    const canvas = document.createElement("canvas");
    title.textContent = `${label} (${unit})`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${device.name} on port ${device.port}, ${label.toLowerCase()} over time`);
    header.append(title, value);
    plot.className = "brainPlot";
    plot.append(canvas);
    panel.append(header, plot);
    graphs.append(panel);
    const chart = new Chart(canvas, {
      type: "line",
      data: { datasets: [{ label, data: [], borderColor: color, backgroundColor: color,
        borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, spanGaps: 0.35 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { type: "linear", title: { display: true, text: "Robot time (s)", color: "#aebdce" },
            ticks: { color: "#aebdce" }, grid: { color: "#263243" } },
          y: { ticks: { color: "#aebdce" }, grid: { color: "#263243" } },
        },
      },
    });
    plots.set(metric, { chart, value, points: [] });
  }

  let session = "";
  let sequence = 0;
  let lastSequence = 0;
  let lastResponse = performance.now();
  const apply = (update: GraphUpdate) => {
    if (update.key !== key || update.sequence <= lastSequence) return;
    lastSequence = update.sequence;
    lastResponse = performance.now();
    const connection = update.online ? "Online" : "Offline";
    if (status.textContent !== connection) status.textContent = connection;
    for (const [metric, graph] of plots) {
      const series = update.signals[metric];
      const incoming = series?.points ?? [];
      const reset = session !== update.session;
      if (reset || incoming.length) {
        // A reply can overlap the previous one when IPC takes longer than a poll.
        const after = reset ? -Infinity : graph.points.at(-1)?.x ?? -Infinity;
        graph.points = [...(reset ? [] : graph.points), ...incoming.filter(point => point.x > after)]
          .slice(-maxSamples);
        graph.chart.data.datasets[0].data = graph.points;
        graph.chart.update("none");
      }
      const last = graph.points.at(-1);
      const reading = last
        ? `${numberFormat.format(last.y)} ${metrics[metric].unit}${series?.recent ? "" : " · Last reading"}`
        : "No readings yet";
      if (graph.value.textContent !== reading) graph.value.textContent = reading;
    }
    session = update.session;
  };
  const unlisten = native
    ? await getCurrentWebviewWindow().listen<GraphUpdate>(graphUpdate, ({ payload }) => apply(payload))
    : undefined;
  if (!native) {
    window.addEventListener("message", ({ data, source, origin }) => {
      if (source === window.opener && origin === location.origin && data?.type === graphUpdate) apply(data.update);
    });
  }

  const poll = () => {
    if (performance.now() - lastResponse > 2000 && status.textContent !== "Brain tab unavailable") {
      status.textContent = "Brain tab unavailable";
      for (const [metric, graph] of plots) {
        const last = graph.points.at(-1);
        if (last) graph.value.textContent = `${numberFormat.format(last.y)} ${metrics[metric].unit} · Last reading`;
      }
    }
    const after: GraphRequest["after"] = {};
    for (const [metric, graph] of plots) {
      const last = graph.points.at(-1);
      if (last) after[metric] = last.x;
    }
    const request: GraphRequest = { key, session, after, sequence: ++sequence };
    if (native) void emitTo("main", graphRequest, request).catch(() => {});
    else window.opener?.postMessage({ type: graphRequest, request }, location.origin);
  };
  poll();
  const timer = window.setInterval(poll, 250);
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    unlisten?.();
  }, { once: true });
}
