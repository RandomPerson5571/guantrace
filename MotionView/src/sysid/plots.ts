import Chart from "chart.js/auto";
import type { ChartDataset } from "chart.js";
import type { Run } from "./capture";
import { simulate, type Fit, type Gains } from "./model";

export type PlotKind = "velocity" | "position" | "voltage" | "quasistatic" | "dynamic" | "residual" | "simulation";
type Point = { x: number; y: number | null };
type Series = ChartDataset<"line", Point[]>;
const colors = ["#77aaff", "#ffad65"];

export class SysIdPlot {
  readonly #chart: Chart<"line", Point[]>;
  cursor: number | null = null;

  constructor(canvas: HTMLCanvasElement, seek: (time: number) => void) {
    this.#chart = new Chart(canvas, {
      type: "line", data: { datasets: [] },
      options: {
        animation: false, maintainAspectRatio: false, parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: { type: "linear", ticks: { color: "#b9c4d0" }, title: { display: true, color: "#b9c4d0" } },
          y: { ticks: { color: "#b9c4d0" }, title: { display: true, color: "#b9c4d0" } },
        },
        plugins: { legend: { labels: { color: "#d9e2ed", boxWidth: 12 } } },
        onClick: event => {
          if (event.x != null) {
            const time = this.#chart.scales.x.getValueForPixel(event.x);
            if (time !== undefined) seek(time);
          }
        },
      },
      plugins: [{
        id: "sysid-replay-cursor",
        afterDatasetsDraw: chart => {
          if (this.cursor === null) return;
          const x = chart.scales.x.getPixelForValue(this.cursor);
          const { left, right, top, bottom } = chart.chartArea;
          if (x < left || x > right) return;
          chart.ctx.save();
          chart.ctx.strokeStyle = "#f1f4fa";
          chart.ctx.beginPath();
          chart.ctx.moveTo(x, top);
          chart.ctx.lineTo(x, bottom);
          chart.ctx.stroke();
          chart.ctx.restore();
        },
      }],
    });
  }

  drawCursor(time: number | null): void {
    this.cursor = time;
    this.#chart.draw();
  }

  render(kind: PlotKind, run: Run | undefined, channels: string[], fits: Map<string, Fit>,
    gains: ReadonlyMap<string, Gains>, validating: boolean): void {
    const series: Series[] = [];
    const add = (label: string, data: Point[], index: number, style: "line" | "dash" | "dots" = "line") => {
      if (!data.some(point => point.y !== null)) return;
      series.push({
        label, data, borderColor: colors[index % colors.length], backgroundColor: colors[index % colors.length],
        showLine: style !== "dots", borderDash: style === "dash" ? [6, 4] : [],
        pointRadius: style === "dots" ? 2 : data.length === 1 ? 3 : 0, borderWidth: 2,
      });
    };
    const first = run?.samples.find(row => channels.includes(row.channel));
    const unit = first?.unit ?? fits.get(channels[0])?.unit ?? "m";
    let x = first?.clock === "robot" ? "Robot time (s)" : "Run time (s)";
    let y = `Velocity (${unit}/s)`;
    for (const [index, channel] of channels.entries()) {
      const rows = run?.samples.filter(row => row.channel === channel) ?? [];
      const fit = fits.get(channel);
      const name = channel === "drive-left" ? "Left" : channel === "drive-right" ? "Right" : channel;
      if (kind === "quasistatic" || kind === "dynamic") {
        const quasistatic = kind === "quasistatic";
        x = quasistatic ? "Applied voltage (V)" : "Applied voltage minus kS and kV terms (V)";
        y = quasistatic ? `Velocity (${unit}/s)` : `Acceleration (${unit}/s²)`;
        if (!fit) continue;
        for (const direction of ["forward", "reverse"]) {
          const points = fit.diagnostics.filter(row => row.sample.test === kind && row.sample.direction === direction);
          add(`${name} ${direction}`, points.map(row => quasistatic
            ? { x: row.sample.voltage, y: row.velocity }
            : { x: row.sample.voltage - fit.gains.kS * Math.sign(row.velocity) - fit.gains.kV * row.velocity,
                y: row.acceleration }), index, "dots");
        }
        continue;
      }
      if (kind === "residual") {
        y = "Measured − fitted voltage (V)";
        const points = new Map(fit?.diagnostics.map(row => [row.sample, row.residual]));
        add(name, rows.map(row => ({ x: row.time, y: points.get(row) ?? null })), index, "dots");
        continue;
      }
      if (kind === "voltage") {
        y = "Applied voltage (V)";
        add(name, rows.map(row => ({ x: row.time, y: row.voltage })), index);
        add(`${name} requested`, rows.map(row => ({ x: row.time, y: row.commandVoltage ?? null })), index, "dash");
      } else if (kind === "position") {
        y = `Position (${unit})`;
        add(`${name} measured`, rows.map(row => ({ x: row.time, y: row.position ?? null })), index);
        add(`${name} target`, rows.map(row => ({ x: row.time, y: row.targetPosition ?? null })), index, "dash");
      } else {
        add(`${name} measured`, rows.map(row => ({ x: row.time, y: row.velocity })), index);
        if (kind === "velocity" || validating) {
          add(`${name} target`, rows.map(row => ({ x: row.time, y: row.targetVelocity ?? null })), index, "dash");
        }
        const model = gains.get(channel);
        if (kind === "simulation" && model) {
          const points = simulate(rows, model).map(row => ({ x: row.sample.time, y: row.simulated }));
          add(`${name} simulated`, points, index, validating ? "dots" : "dash");
        }
      }
    }
    this.#chart.data.datasets = series;
    const { scales } = this.#chart.options;
    scales!.x!.title!.text = x;
    scales!.y!.title!.text = y;
    this.#chart.update("none");
  }
}
