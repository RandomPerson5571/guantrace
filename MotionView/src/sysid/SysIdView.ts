import type { BridgeService } from "../app/BridgeService";
import { setMode, subscribeMode } from "../app/modeController";
import { requiredElement } from "../dom/elements";
import type { LiveEvents } from "../live/LiveEvents";
import type { ViewingFeature } from "../viewing/ViewingFeature";
import { Capture, MAX_CAPTURE_BYTES, MAX_SAMPLES, parseBatch, parseCapture, runHealth, runKey, type Run, type Unit } from "./capture";
import { DriveLabCapture, isDriveLabRecord, parseDriveLabCapture } from "./driveLab";
import { canSimulate, fitChannel, predictionMetrics, runFingerprint, simulate, type ErrorMetrics, type Fit, type Gains } from "./model";
import { SysIdPlot, type PlotKind } from "./plots";
import { SignalMappingView } from "./SignalMappingView";
import { SignalCapture, type Mapping } from "./signals";
import { Nt4Session } from "./nt4";
import { MAX_WPILOG_BYTES, WpiLog } from "./wpilog";
import "./sysid.css";

type Page = "profile" | "validation";
type SavedChannel = { gains: Gains; unit: Unit; training: string[] };
type SavedProfile = Record<string, SavedChannel>;
const profileKey = "guantrace.sysid.profile.v1";

function readProfile(): SavedProfile {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(profileKey) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const entries = Object.entries(value).filter(([, channel]) =>
      channel && (channel.unit === "m" || channel.unit === "rad") && channel.gains &&
      ["kS", "kV", "kA"].every(key => Number.isFinite(channel.gains[key])) && canSimulate(channel.gains) &&
      Array.isArray(channel.training) && channel.training.every((key: unknown) =>
        typeof key === "string" && /^[a-f0-9]{64}$/.test(key)));
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function setOptions(select: HTMLSelectElement, items: [string, string][]): void {
  if (select.options.length === items.length && items.every(([value, label], i) =>
    select.options[i].value === value && select.options[i].text === label)) return;
  const selected = select.value;
  select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
  if (items.some(([value]) => value === selected)) select.value = selected;
}

const fmt = (value: number | null | undefined) =>
  value == null ? "—" : Number(value.toPrecision(4)).toString();

function channelName(channel: string): string {
  if (channel === "drive-left") return "Left";
  if (channel === "drive-right") return "Right";
  return channel;
}

function runName(run: Run): string {
  const { runId, mode, test, direction } = run.samples[0];
  return `#${runId} · ${mode} ${test} ${direction}`;
}

function metricsText(metrics: ErrorMetrics | null, unit: Unit): string {
  return metrics ? `R² ${fmt(metrics.rSquared)} · RMSE ${fmt(metrics.rmse)} ${unit}/s · Mean error ${fmt(metrics.bias)} ${unit}/s · n=${metrics.count}`
    : "Unavailable";
}

interface Slot {
  capture: Capture;
  label: string;
  lines: string[];
  mapped?: SignalCapture;
  driveLab?: DriveLabCapture;
}

function emptySlot(): Slot {
  return { capture: new Capture(), label: "", lines: [] };
}

export class SysIdView {
  readonly #panel = requiredElement("sysidPanel", HTMLElement);
  readonly #profileButton = requiredElement("sysidProfile", HTMLButtonElement);
  readonly #validationButton = requiredElement("sysidValidation", HTMLButtonElement);
  readonly #file = requiredElement("sysidFile", HTMLInputElement);
  readonly #import = requiredElement("sysidImport", HTMLButtonElement);
  readonly #live = requiredElement("sysidLive", HTMLButtonElement);
  readonly #nt4Button = requiredElement("sysidNt4", HTMLButtonElement);
  readonly #download = requiredElement("sysidDownload", HTMLButtonElement);
  readonly #source = requiredElement("sysidSource", HTMLElement);
  readonly #message = requiredElement("sysidMessage", HTMLElement);
  readonly #run = requiredElement("sysidRun", HTMLSelectElement);
  readonly #channel = requiredElement("sysidChannel", HTMLSelectElement);
  readonly #kind = requiredElement("sysidPlotKind", HTMLSelectElement);
  readonly #exclude = requiredElement("sysidExclude", HTMLInputElement);
  readonly #health = requiredElement("sysidHealth", HTMLElement);
  readonly #fit = requiredElement("sysidFit", HTMLButtonElement);
  readonly #save = requiredElement("sysidSave", HTMLButtonElement);
  readonly #compare = requiredElement("sysidCompare", HTMLButtonElement);
  readonly #savedLabel = requiredElement("sysidSaved", HTMLElement);
  readonly #metrics = requiredElement("sysidMetrics", HTMLElement);
  readonly #replay = requiredElement("sysidReplay", HTMLDetailsElement);
  readonly #offset = requiredElement("sysidOffset", HTMLInputElement);
  readonly #mappedPoses = requiredElement("sysidMappedPoses", HTMLButtonElement);
  readonly #link = requiredElement("sysidLink", HTMLButtonElement);
  readonly #seek = requiredElement("sysidSeek", HTMLInputElement);
  readonly #go = requiredElement("sysidGo", HTMLButtonElement);
  readonly #replayStatus = requiredElement("sysidReplayStatus", HTMLElement);
  readonly #slots: Record<Page, Slot> = { profile: emptySlot(), validation: emptySlot() };
  #page: Page = "profile";
  #livePage: Page | null = null;
  #nt4: Nt4Session | null = null;
  readonly #mapping: SignalMappingView;
  #liveBytes = 0;
  #droppedBatches = 0;
  #liveDraft: Slot | null = null;
  #refresh: number | null = null;
  #streaming = false;
  #busy = false;
  #pendingLogName = "";
  #saved = readProfile();
  #fits = new Map<string, Fit>();
  #trial = new Map<string, Gains>();
  #fitErrors = new Map<string, string>();
  #comparison = new Map<string, Map<string, Gains>>();
  #replayOffset: number | null = null;
  #plot: SysIdPlot | null = null;

  constructor(live: LiveEvents, private readonly viewing: ViewingFeature, private readonly bridge: BridgeService) {
    this.#mapping = new SignalMappingView((log, mapping, host) => void this.mapSignals(log, mapping, host));
    this.#nt4Button.addEventListener("click", () => {
      if (this.#nt4) this.#nt4.stop();
      else this.#mapping.open(null);
    });
    this.#mappedPoses.addEventListener("click", () => this.openMappedPoses());
    subscribeMode(mode => {
      this.#panel.hidden = mode !== "sysid";
      if (this.#panel.hidden) return;
      this.#plot ??= new SysIdPlot(requiredElement("sysidCanvas", HTMLCanvasElement), time => this.seek(time));
      this.render();
      this.updateCursor();
    });
    this.#profileButton.addEventListener("click", () => this.switchPage("profile"));
    this.#validationButton.addEventListener("click", () => this.switchPage("validation"));
    this.#import.addEventListener("click", () => this.#file.click());
    this.#file.addEventListener("change", () => void this.openFile());
    this.#live.addEventListener("click", () => this.toggleCapture());
    this.#download.addEventListener("click", () => this.download());
    for (const control of [this.#run, this.#channel, this.#kind]) {
      control.addEventListener("change", () => {
        if (control === this.#run) this.unlinkReplay();
        this.render();
      });
    }
    this.#exclude.addEventListener("change", () => {
      const run = this.selectedRun;
      if (!run) return;
      run.excluded = this.#exclude.checked;
      if (this.#page === "profile") this.clearFits();
      if (run.excluded) this.unlinkReplay();
      this.render();
    });
    this.#fit.addEventListener("click", () => this.fit());
    this.#save.addEventListener("click", () => void this.save());
    this.#compare.addEventListener("click", () => void this.compare());
    this.#offset.addEventListener("input", () => this.unlinkReplay());
    this.#link.addEventListener("click", () => this.linkReplay());
    this.#go.addEventListener("click", () => this.seek(this.#seek.valueAsNumber));
    this.#seek.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.seek(this.#seek.valueAsNumber);
    });
    live.sysIdBatch.subscribe(line => this.receive(line));
    live.streamChanged.subscribe(({ current }) => {
      this.#streaming = current === "streaming";
      if (current === "idle" && this.#livePage) this.stopCapture("Robot stream ended.");
      this.render();
    });
    viewing.events.playbackChanged.subscribe(() => this.updateCursor());
    viewing.events.navigationChanged.subscribe(() => this.updateCursor());
    viewing.events.dataChanged.subscribe(({ kind }) => {
      if (kind === "replaced" || kind === "cleared") this.unlinkReplay();
    });
  }

  private get slot(): Slot { return this.#slots[this.#page]; }
  private get selectedRun(): Run | undefined { return this.slot.capture.runs.get(this.#run.value); }

  private switchPage(page: Page): void {
    if (page === this.#page) return;
    this.#mapping.close();
    this.#trial.clear();
    this.#page = page;
    this.#kind.value = "velocity";
    this.#message.textContent = "";
    this.unlinkReplay();
    this.render();
  }

  private clearFits(): void {
    this.#trial.clear();
    this.#fits.clear();
    this.#fitErrors.clear();
  }

  private replace(page: Page, slot: Slot): void {
    this.#slots[page] = slot;
    if (page === "profile") this.clearFits();
    else {
      this.#trial.clear();
      this.#comparison.clear();
      this.unlinkReplay();
    }
  }

  private async openFile(): Promise<void> {
    const file = this.#file.files?.[0];
    this.#file.value = "";
    if (!file || this.#livePage || this.#nt4 || this.#busy) return;
    const page = this.#page;
    this.#busy = true;
    this.render();
    try {
      this.#mapping.close();
      if (file.name.toLowerCase().endsWith(".wpilog")) {
        if (file.size > MAX_WPILOG_BYTES) throw new Error("WPILOG exceeds 128 MB.");
        this.#pendingLogName = file.name;
        this.#mapping.open(new WpiLog(await file.arrayBuffer()));
      } else {
        if (file.size > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds 32 MB.");
        const content = await file.text();
        const capture = file.name.toLowerCase().endsWith(".gt1")
          ? parseDriveLabCapture(content)
          : parseCapture(content);
        this.replace(page, { capture, label: file.name, lines: [] });
      }
      this.#message.textContent = "";
    } catch (error) {
      this.#message.textContent = (error as Error).message;
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  private async mapSignals(log: WpiLog | null, mapping: Mapping, host: string): Promise<void> {
    if (this.#busy || this.#livePage || this.#nt4) return;
    const page = this.#page;
    this.#busy = true;
    this.render();
    try {
      const source = new SignalCapture(mapping);
      if (log) {
        log.read(source.names, event => source.receive(event));
        source.drain(true);
        if (!source.capture.count)
          throw new Error(source.diagnostic() || "No aligned WPILOG samples. Check timestamps and test state.");
        this.replace(page, { capture: source.capture, label: this.#pendingLogName, lines: [] });
        this.#message.textContent = source.diagnostic();
      } else {
        await this.bridge.resolveOrigin();
        const url = this.bridge.sysIdNt4Url;
        if (!url) throw new Error("Open the guantrace desktop app to connect to NT4.");
        const slot = { capture: source.capture, label: `NT4 · ${host}`, lines: [], mapped: source };
        const install = () => {
          if (source.capture.count && this.#slots[page] !== slot) this.replace(page, slot);
        };
        this.#nt4 = new Nt4Session(url, host, source, status => {
          install();
          this.#message.textContent = status;
          this.render();
        }, status => {
          this.#nt4 = null;
          install();
          this.#message.textContent = status;
          this.render();
        });
        this.#message.textContent = "Connecting to NT4…";
      }
      this.#mapping.close();
    } catch (error) {
      this.#message.textContent = (error as Error).message;
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  private openMappedPoses(): void {
    const poses = this.slot.capture.poses.map(pose => ({
      t: pose.time * 1000, x: pose.x / 0.0254, y: pose.y / 0.0254,
      theta: 90 - pose.heading * 180 / Math.PI,
    }));
    if (!poses.length) return;
    this.viewing.load({ poses });
    this.#offset.value = "0";
    this.linkReplay();
    setMode("viewing");
    requiredElement("modeViewing", HTMLButtonElement).focus();
  }

  private toggleCapture(): void {
    if (this.#livePage) {
      this.stopCapture("");
      return;
    }
    if (!this.#streaming || this.#busy || this.#nt4) return;
    this.#mapping.close();
    this.#livePage = this.#page;
    this.#liveDraft = null;
    this.#liveBytes = 0;
    this.#droppedBatches = 0;
    this.#message.textContent = "";
    // Preserve the previous capture until the robot sends a valid batch.
    this.render();
  }

  private stopCapture(message: string): void {
    this.#livePage = null;
    this.#liveDraft = null;
    this.#message.textContent = [message, this.#droppedBatches ? `Skipped ${this.#droppedBatches} invalid batches.` : ""]
      .filter(Boolean).join(" ");
    this.render();
  }

  private receive(line: string): void {
    const page = this.#livePage;
    if (!page) return;
    try {
      const isDriveLab = isDriveLabRecord(line);
      if (this.#liveDraft && isDriveLab !== Boolean(this.#liveDraft.driveLab)) {
        if (this.#liveDraft.capture.count) return;
        this.#liveDraft = null;
        this.#liveBytes = 0;
      }
      const bytes = new TextEncoder().encode(line).length + 1;
      if (this.#liveBytes + bytes > MAX_CAPTURE_BYTES) {
        this.stopCapture("Live capture reached 32 MB.");
        return;
      }
      const driveLab = isDriveLab ? this.#liveDraft?.driveLab ?? new DriveLabCapture() : undefined;
      const slot = this.#liveDraft ?? {
        capture: driveLab?.capture ?? new Capture(), lines: [],
        label: driveLab ? "DriveLab telemetry" : "Live capture", driveLab,
      };
      this.#liveDraft = slot;
      const hadSamples = slot.capture.count > 0;
      if (driveLab) {
        if (slot.capture.count >= MAX_SAMPLES) {
          this.stopCapture("Live capture reached 100,000 channel samples.");
          return;
        }
        if (!driveLab.receive(line)) return;
      } else {
        const samples = parseBatch(line);
        if (slot.capture.count + samples.length > MAX_SAMPLES) {
          this.stopCapture("Live capture reached 100,000 channel samples.");
          return;
        }
        slot.capture.append(samples);
      }
      slot.lines.push(line);
      if (!hadSamples && slot.capture.count) this.replace(page, slot);
      this.#liveBytes += bytes;
    } catch (error) {
      this.#droppedBatches++;
      this.#message.textContent = `Skipped ${this.#droppedBatches} batches. ${(error as Error).message}`;
    }
    if (this.#refresh === null) this.#refresh = window.setTimeout(() => {
      this.#refresh = null;
      this.render();
    }, 200);
  }

  private download(): void {
    const lines = this.slot.mapped?.exportLines() ?? this.slot.lines;
    const url = URL.createObjectURL(new Blob([lines.join("\n"), "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = this.slot.driveLab ? "drive-lab-sysid.gt1" : "sysid-capture.log";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private fit(): void {
    this.clearFits();
    const runs = [...this.slot.capture.runs.values()];
    for (const channel of this.slot.capture.units.keys()) {
      try { this.#fits.set(channel, fitChannel(runs, channel)); }
      catch (error) { this.#fitErrors.set(channel, (error as Error).message); }
    }
    if (this.#fits.size) this.#kind.value = "quasistatic";
    this.render();
  }

  private async save(): Promise<void> {
    const fits = [...this.#fits];
    const capture = this.#slots.profile.capture;
    this.#busy = true;
    this.render();
    try {
      const entries = await Promise.all(fits.filter(([, fit]) => canSimulate(fit.gains)).map(async ([name, fit]) => {
        const keys = [...new Set(fit.diagnostics.map(({ sample }) => runKey(sample)))];
        const training = await Promise.all(keys.map(key => runFingerprint(capture.runs.get(key)!, name)));
        return [name, { gains: fit.gains, unit: fit.unit, training }] as const;
      }));
      const profile = Object.fromEntries(entries);
      localStorage.setItem(profileKey, JSON.stringify(profile));
      this.#saved = profile;
      this.#comparison.clear();
      this.#message.textContent = "Gains saved on this device.";
    } catch {
      this.#message.textContent = "Could not save gains on this device.";
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  private async compare(): Promise<void> {
    const runs = [...this.#slots.validation.capture.runs.values()];
    this.#busy = true;
    this.render();
    try {
      let reused = 0;
      this.#trial.clear();
      this.#comparison.clear();
      for (const run of runs) {
        if (run.samples[0].mode !== "linear") continue;
        const matching = new Map<string, Gains>();
        let sharesTraining = false;
        for (const channel of new Set(run.samples.map(row => row.channel))) {
          const saved = Object.hasOwn(this.#saved, channel) ? this.#saved[channel] : undefined;
          if (!saved || this.slot.capture.units.get(channel) !== saved.unit) continue;
          if (saved.training.includes(await runFingerprint(run, channel))) sharesTraining = true;
          matching.set(channel, saved.gains);
        }
        if (sharesTraining) reused++;
        else if (matching.size) this.#comparison.set(run.key, matching);
      }
      this.#kind.value = "simulation";
      this.#message.textContent = reused ? `Skipped ${reused} run(s) used for fitting. Choose a new recording.` :
        this.#comparison.size ? "" : "No independent linear runs match the saved gain channels and units.";
    } catch {
      this.#comparison.clear();
      this.#message.textContent = "Could not verify that the validation recording is independent.";
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  private unlinkReplay(): void {
    this.#replayOffset = null;
    this.#seek.disabled = this.#go.disabled = true;
    this.#replayStatus.textContent = "Open the matching route in Viewing, then link its timeline.";
    this.#plot?.drawCursor(null);
  }

  private linkReplay(): void {
    const run = this.selectedRun;
    const range = this.viewing.projection.timeRange();
    const offset = this.#offset.valueAsNumber;
    if (!run || !range || !Number.isFinite(offset)) {
      this.#replayStatus.textContent = "Open a route with poses and enter a replay offset.";
      return;
    }
    const min = run.samples.reduce((min, row) => Math.min(min, row.time), Infinity);
    const max = run.samples.reduce((max, row) => Math.max(max, row.time), -Infinity);
    const start = Math.max(min, (range.start - offset) / 1000);
    const end = Math.min(max, (range.end - offset) / 1000);
    if (start >= end) {
      this.#replayStatus.textContent = "The timelines do not overlap. Adjust the offset.";
      return;
    }
    this.#replayOffset = offset;
    this.#seek.disabled = this.#go.disabled = false;
    this.#seek.min = String(start);
    this.#seek.max = String(end);
    this.seek(start);
  }

  private seek(time: number): void {
    if (this.#panel.hidden || this.#page !== "validation" || this.#replayOffset === null ||
        !Number.isFinite(time)) return;
    const bounded = Math.min(Number(this.#seek.max), Math.max(Number(this.#seek.min), time));
    this.viewing.playback.pause();
    const replayTime = bounded * 1000 + this.#replayOffset;
    this.viewing.navigation.setTimelineHover(null);
    this.viewing.navigation.setTrackHover(null);
    this.viewing.playback.setTime(replayTime);
    const pose = this.viewing.projection.interpolatePose(replayTime);
    if (pose) this.viewing.navigation.lockTrack(pose, this.viewing.projection.findFloorIndex(replayTime));
    this.updateCursor();
  }

  private updateCursor(): void {
    if (this.#panel.hidden || this.#replayOffset === null) return;
    const pose = this.viewing.playback.currentDisplayPose();
    const time = pose?.t != null ? (pose.t - this.#replayOffset) / 1000 : null;
    const inRange = time !== null && time >= Number(this.#seek.min) && time <= Number(this.#seek.max);
    this.#plot?.drawCursor(inRange ? time : null);
    if (document.activeElement !== this.#seek) this.#seek.value = inRange ? time.toFixed(3) : "";
    this.#replayStatus.textContent = inRange
      ? `Replay ${fmt(pose?.t)} ms · X ${fmt(pose?.x)} · Y ${fmt(pose?.y)}`
      : "Replay cursor is outside the linked run.";
  }

  private render(): void {
    if (this.#panel.hidden) return;
    const training = this.#page === "profile";
    const pros = this.#livePage !== null;
    const live = pros || this.#nt4 !== null;
    const { capture, label, lines, mapped } = this.slot;
    this.#profileButton.setAttribute("aria-pressed", String(training));
    this.#validationButton.setAttribute("aria-pressed", String(!training));
    this.#profileButton.disabled = live || this.#busy;
    this.#validationButton.disabled = live || this.#busy;
    this.#import.disabled = live || this.#busy;
    this.#live.textContent = pros ? "Stop PROS capture" : "Capture PROS";
    this.#live.disabled = !pros && (!this.#streaming || this.#busy || this.#nt4 !== null);
    this.#nt4Button.textContent = this.#nt4 ? "Stop NT4 capture" : "Connect NT4";
    this.#nt4Button.disabled = pros || this.#busy;
    this.#live.title = this.#streaming ? "" : "Start the robot stream first";
    this.#download.hidden = live || (!lines.length && !mapped);
    this.#source.textContent = pros && !this.#liveDraft?.capture.count ? "Waiting for SysId samples from the robot." :
      label ? `${label} · ${capture.count.toLocaleString()} channel samples` :
      training ? "Import a capture or stream SysId from the robot." : "Import or stream a separate validation run.";
    setOptions(this.#run, [...capture.runs.values()].map(run => [run.key, runName(run)]));
    const run = this.selectedRun;
    const names = [...new Set(run?.samples.map(row => row.channel))];
    const both = names.includes("drive-left") && names.includes("drive-right") &&
      capture.units.get("drive-left") === capture.units.get("drive-right");
    const channelOptions: [string, string][] = names.map(name => [name, channelName(name)]);
    if (both) channelOptions.unshift(["", "Left and right"]);
    setOptions(this.#channel, channelOptions);
    const channels = this.#channel.value ? [this.#channel.value] : ["drive-left", "drive-right"];
    this.#exclude.disabled = !run || live || this.#busy;
    this.#exclude.checked = run?.excluded ?? false;
    const health = run ? runHealth(run) : null;
    this.#health.textContent = health ? [
      health.hz === null ? "Rate unavailable" : `${fmt(health.hz)} Hz${health.hz < 50 - 1e-6 ? " · Below 50 Hz" : ""}`,
      health.sag === null ? "Battery unlogged" : `Battery sag ${fmt(health.sag)} V${health.sag > 1 ? " · Review run" : ""}`,
      health.gaps ? `${health.gaps} gaps over 100 ms` : "",
      run?.samples[0].mode === "angular" ? "Opposite wheel directions are expected during a spin." : "",
    ].filter(Boolean).join(" · ") : "";
    this.#fit.hidden = this.#save.hidden = !training;
    this.#compare.hidden = training;
    this.#fit.disabled = live || this.#busy || !capture.count;
    this.#save.disabled = live || this.#busy || ![...this.#fits.values()].some(fit => canSimulate(fit.gains));
    this.#compare.disabled = live || this.#busy || !capture.count || !Object.keys(this.#saved).length;
    this.#savedLabel.textContent = Object.keys(this.#saved).length ? "Saved gains available" : "No saved gains";
    this.#replay.hidden = training || !run || run.excluded;
    this.#mappedPoses.hidden = capture.poses.length < 2;
    this.#mappedPoses.disabled = live || this.#busy;
    for (const option of this.#kind.options) {
      option.disabled = !training && ["quasistatic", "dynamic", "residual"].includes(option.value);
    }
    const gains = training ? new Map([...this.#fits].map(([key, fit]) => [key, fit.gains])) :
      run && !run.excluded ? this.#comparison.get(run.key) ?? new Map<string, Gains>() : new Map<string, Gains>();
    for (const [channel, trial] of this.#trial) if (gains.has(channel)) gains.set(channel, trial);
    this.#plot?.render(this.#kind.value as PlotKind, run, channels, this.#fits, gains, !training);
    this.renderMetrics(training, run, channels, gains);
  }

  private renderMetrics(training: boolean, run: Run | undefined, channels: string[], gains: Map<string, Gains>): void {
    const cards: HTMLElement[] = [];
    const names = training ? [...new Set([...this.#fits.keys(), ...this.#fitErrors.keys()])] : channels;
    for (const name of names) {
      const rows = run?.samples.filter(row => row.channel === name) ?? [];
      const fit = this.#fits.get(name);
      const model = gains.get(name);
      const messages: string[] = [];
      if (training && fit) {
        const unit = fit.unit;
        const rSquared = fit.simulation?.rSquared;
        messages.push(
          `kS ${fmt(fit.gains.kS)} V · kV ${fmt(fit.gains.kV)} V/(${unit}/s) · kA ${fmt(fit.gains.kA)} V/(${unit}/s²)`,
          `Voltage fit R² ${fmt(fit.voltage?.rSquared)} · RMSE ${fmt(fit.voltage?.rmse)} V`,
          `Acceleration R² ${fmt(fit.acceleration?.rSquared)} · ${fit.diagnostics.length} retained samples`,
          `Simulated velocity R² ${fmt(rSquared)}${rSquared != null && rSquared >= 0.99 ? " · Close match" : ""}`,
          metricsText(fit.simulation, unit), ...fit.warnings,
        );
      } else if (training && this.#fitErrors.has(name)) {
        messages.push(this.#fitErrors.get(name)!);
      } else if (!training && rows.length && !run?.excluded) {
        const metrics = predictionMetrics(model ? simulate(rows, model) : rows.map(sample => ({ sample, simulated: null })));
        const unit = rows[0].unit;
        messages.push(`Model error · ${metricsText(metrics.model, unit)}`,
          `Target tracking · ${metricsText(metrics.tracking, unit)}`);
        if (model && metrics.model && metrics.model.count < rows.length - 1)
          messages.push("Prediction stops at the first timestamp gap.");
      }
      if (!messages.length) continue;
      const card = document.createElement("div");
      const heading = document.createElement("h3");
      heading.textContent = channelName(name);
      card.append(heading);
      for (const message of messages) {
        const p = document.createElement("p");
        p.textContent = message;
        card.append(p);
      }
      if (model && rows.length) {
        const form = document.createElement("form");
        form.className = "sysidRow";
        const inputs = (["kS", "kV", "kA"] as const).map(key => {
          const label = document.createElement("label");
          label.textContent = key;
          const input = document.createElement("input");
          input.type = "number"; input.step = "any"; input.required = true;
          input.value = String(model[key]); input.setAttribute("aria-label", `${name} ${key}`);
          label.append(input); form.append(label);
          return input;
        });
        const apply = document.createElement("button");
        apply.textContent = "Try gains"; apply.type = "submit";
        const reset = document.createElement("button");
        reset.textContent = "Reset trial"; reset.type = "button";
        reset.addEventListener("click", () => { this.#trial.delete(name); this.render(); });
        form.append(apply, reset);
        form.addEventListener("submit", event => {
          event.preventDefault();
          const trial = { kS: inputs[0].valueAsNumber, kV: inputs[1].valueAsNumber, kA: inputs[2].valueAsNumber };
          if (!canSimulate(trial)) { inputs[0].setCustomValidity("Use kS ≥ 0, kV > 0 and kA > 0."); inputs[0].reportValidity(); return; }
          this.#trial.set(name, trial); this.#kind.value = "simulation"; this.render();
        });
        inputs.forEach(input => input.addEventListener("input", () => inputs[0].setCustomValidity("")));
        card.append(form);
        if (this.#trial.has(name)) {
          const note = document.createElement("p");
          note.textContent = `Trial simulation · ${metricsText(predictionMetrics(simulate(rows, model)).model, rows[0].unit)}. Saved gains are unchanged.`;
          card.append(note);
        }
      }
      cards.push(card);
    }
    const left = this.#fits.get("drive-left")?.gains;
    const right = this.#fits.get("drive-right")?.gains;
    if (training && left && right) {
      const names = (["kS", "kV", "kA"] as const).filter(key =>
        Math.abs(left[key] - right[key]) > 0.25 * Math.max(Math.abs(left[key]), Math.abs(right[key]), 1e-6));
      if (names.length) {
        const note = document.createElement("p");
        note.textContent = `Left and right ${names.join(", ")} differ by more than 25%.`;
        cards.push(note);
      }
    }
    this.#metrics.replaceChildren(...cards);
  }
}
