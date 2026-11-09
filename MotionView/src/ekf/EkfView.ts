import Chart from "chart.js/auto";
import type { ChartDataset } from "chart.js";
import { requiredElement } from "../dom/elements";
import { subscribeMode } from "../app/modeController";
import type { LiveEvents } from "../live/LiveEvents";
import { consistency, parseInnovation, sourceName, type Innovation } from "./diagnostics";

type Point = { x: number; y: number | null };
const fmt = (n: number) => Number(n.toPrecision(4)).toString();
export class EkfView {
  #rows: Innovation[] = [];
  #lines: string[] = [];
  #paused = false;
  #streaming = false;
  #missed = 0;
  #invalid = 0;
  #last: Innovation | null = null;
  #timer: number | null = null;
  #visible = false;
  #chart: Chart<"line", Point[]> | null = null;
  readonly #source = requiredElement("ekfSource", HTMLSelectElement);
  readonly #kind = requiredElement("ekfKind", HTMLSelectElement);
  readonly #status = requiredElement("ekfStatus", HTMLElement);
  readonly #metrics = requiredElement("ekfMetrics", HTMLElement);
  readonly #advice = requiredElement("ekfAdvice", HTMLElement);
  readonly #panel = requiredElement("ekfPanel", HTMLElement);
  constructor(live: LiveEvents) {
    const pause = requiredElement("ekfPause", HTMLButtonElement);
    pause.onclick = () => {
      this.#paused = !this.#paused;
      pause.textContent = this.#paused ? "Resume" : "Pause";
      pause.setAttribute("aria-pressed", String(this.#paused));
      if (!this.#paused) this.render();
    };
    requiredElement("ekfClear", HTMLButtonElement).onclick = () => { this.clear(); this.render(); };
    const file = requiredElement("ekfFile", HTMLInputElement);
    const importButton = requiredElement("ekfImport", HTMLButtonElement);
    importButton.onclick = () => file.click();
    file.onchange = async () => {
      const selected = file.files?.[0]; file.value = "";
      if (!selected) return;
      if (this.#streaming) { this.#status.textContent = "Stop the robot stream before importing an EKF log."; return; }
      if (selected.size > 32 * 1024 * 1024) { this.#status.textContent = "EKF log exceeds 32 MB."; return; }
      try {
        const lines = (await selected.text()).split(/\r?\n/).filter(line => line.startsWith("GTE1,"));
        if (this.#streaming) throw new Error("Stop the robot stream before importing an EKF log.");
        if (!lines.some(line => parseInnovation(line))) throw new Error("No valid EKF records in this file.");
        this.clear(); lines.forEach(line => this.receive(line)); this.render();
      } catch (error) { this.#status.textContent = (error as Error).message; }
    };
    requiredElement("ekfExport", HTMLButtonElement).onclick = () => {
      const url = URL.createObjectURL(new Blob([this.#lines.join("\n") + "\n"], { type: "text/plain" }));
      const link = document.createElement("a"); link.href = url; link.download = "ekf.gt1"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    this.#source.onchange = this.#kind.onchange = () => this.render();
    subscribeMode(mode => {
      this.#visible = mode === "ekf";
      this.#panel.hidden = !this.#visible;
      this.render();
    });
    live.streamChanged.subscribe(({ current }) => {
      this.#streaming = current !== "idle";
      importButton.disabled = this.#streaming;
      importButton.title = this.#streaming ? "Stop the robot stream before importing" : "";
      if (current === "starting") { this.clear(); this.render(); }
    });
    live.diagnosticRecord.subscribe(line => {
      if (!line.startsWith("GTE1,")) return;
      this.receive(line);
      if (this.#timer === null) this.#timer = window.setTimeout(() => {
        this.#timer = null;
        if (!this.#paused) this.render();
      }, 250);
    });
  }
  private clear(): void {
    this.#rows = []; this.#lines = []; this.#last = null; this.#missed = 0; this.#invalid = 0;
  }
  private receive(line: string): void {
    const row = parseInnovation(line);
    if (!row) { this.#invalid++; return; }
    const last = this.#last;
    if (last && (row.epoch !== last.epoch || ((row.time - (last.time >>> 0)) | 0) < 0)) this.clear();
    else if (last) {
      const delta = (row.sequence - last.sequence) >>> 0;
      if (!delta || delta > 0x7fffffff) return;
      this.#missed += delta - 1;
      row.time = last.time + ((row.time - (last.time >>> 0)) >>> 0);
    }
    this.#last = row;
    this.#rows.push(row); this.#lines.push(line);
    if (this.#rows.length > 6000) { this.#rows.shift(); this.#lines.shift(); }
  }
  private render(): void {
    if (!this.#visible) return;
    const sources = [...new Set(this.#rows.map(row => row.source))].sort((a, b) => a - b);
    const selected = this.#source.value;
    this.#source.replaceChildren(...sources.map(source => new Option(sourceName(source), String(source))));
    if (selected !== "" && sources.includes(Number(selected))) this.#source.value = selected;
    const rows = this.#rows.filter(row => row.source === Number(this.#source.value)).slice(-1200);
    this.#status.textContent = `${this.#paused ? "Paused view · " : ""}${rows.length} updates · ${this.#missed} missing · ${this.#invalid} invalid. Latest reset only; rolling window.`;
    const stats = consistency(rows);
    this.#metrics.textContent = stats ?
      `Mean innovation ${fmt(stats.meanResidual)} · Mean NIS ${fmt(stats.meanNis)} (expected 1; 95% average bounds ${fmt(stats.averageLower)}–${fmt(stats.averageUpper)}) · NIS coverage ${fmt(stats.coverage * 100)}% (expected 95%) · Within ±3σ ${fmt(stats.threeSigma * 100)}% (expected 99.7%) · ${stats.rejected} rejected` : "No measurements yet.";
    this.#advice.textContent = !stats ? "" : [
      stats.meanNis > stats.averageUpper ? "High NIS: check model bias and underestimated Q or R." :
        stats.meanNis < stats.averageLower ? "Low NIS: check inflated Q or R." : "Mean NIS is inside the reference bounds.",
      Math.abs(stats.meanNormalized) > 1.96 / Math.sqrt(stats.count) ? "Innovation mean differs from zero; inspect sensor bias and the motion model." : "",
      "ACF should be near zero at nonzero lags. Correlation can indicate unmodeled dynamics or low Q. Bounds are approximate when samples are correlated or missing. Q/R cannot be identified from NIS alone.",
    ].filter(Boolean).join(" ");
    this.#chart ??= new Chart(requiredElement("ekfCanvas", HTMLCanvasElement), {
      type: "line", data: { datasets: [] }, options: {
        animation: false, parsing: false, maintainAspectRatio: false,
        scales: { x: { type: "linear", ticks: { color: "#b9c4d0" }, title: { display: true, color: "#b9c4d0" } }, y: { ticks: { color: "#b9c4d0" }, title: { display: true, color: "#b9c4d0" } } },
        plugins: { legend: { labels: { color: "#b9c4d0" } } },
      },
    });
    const series: ChartDataset<"line", Point[]>[] = [];
    const add = (label: string, data: Point[], color: string, dashed = false) => series.push({
      label, data, borderColor: color, backgroundColor: color, borderWidth: 1.5,
      borderDash: dashed ? [5, 4] : [], pointRadius: rows.length === 1 ? 3 : 0,
    });
    const time = (f: (row: Innovation) => number | null) => rows.map(row => ({ x: row.time / 1000, y: f(row) }));
    if (stats) {
      if (this.#kind.value === "acf") {
        add("Normalized innovation ACF", stats.acf, "#8bb8ff");
        for (const sign of [-1, 1]) add(`${sign > 0 ? "+" : "−"}95% reference`, stats.acf.map(p => ({ x: p.x, y: sign * stats.acfBound })), "#ffbf7b", true);
      } else if (this.#kind.value === "gain") {
        ["x", "y", "heading", "velocity", "yaw rate", "gyro bias"].forEach((name, i) =>
          add(`K · ${name} (state SI / measurement SI)`, time(row => row.gain[i]), ["#8bb8ff", "#ffbf7b", "#8cdbb0", "#d3a4ff", "#ff8090", "#dbd97d"][i]));
      } else if (this.#kind.value === "nis") {
        add("NIS", time(row => row.residual ** 2 / row.variance), "#8bb8ff");
        add("2.5% χ²(1)", time(() => stats.lower), "#ffbf7b", true);
        add("97.5% χ²(1)", time(() => stats.upper), "#ffbf7b", true);
      } else {
        add("Innovation", time(row => row.residual), "#8bb8ff");
        for (const sign of [-1, 1]) add(`${sign > 0 ? "+" : "−"}3√S`, time(row => sign * 3 * Math.sqrt(row.variance)), "#ffbf7b", true);
        series.push({ label: "Rejected", data: time(row => row.accepted ? null : row.residual), showLine: false, pointRadius: 4, pointStyle: "crossRot", borderColor: "#ff8090" });
      }
    }
    this.#chart.data.datasets = series;
    this.#chart.options.scales!.x!.title = { display: true, color: "#b9c4d0", text: this.#kind.value === "acf" ? "Measurement lag (samples)" : "Robot time (s)" };
    this.#chart.update("none");
  }
}
