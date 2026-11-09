import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({
  configFile: "vite.config.js", logLevel: "error",
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
});
try {
  const { Capture, parseCapture, parseBatch, runHealth } = await server.ssrLoadModule("/sysid/capture.ts");
  const { DriveLabCapture, isDriveLabRecord, parseDriveLabCapture } = await server.ssrLoadModule("/sysid/driveLab.ts");
  const { fitChannel, stepVelocity, simulate, predictionMetrics, runFingerprint } =
    await server.ssrLoadModule("/sysid/model.ts");
  const gains = { kS: 0.3, kV: 2.2, kA: 0.5 };
  const capture = new Capture();
  const testRuns = (weak = false) => {
    const lines = [];
    for (const [index, test] of ["quasistatic", "dynamic"].entries()) {
      for (const [di, direction] of ["forward", "reverse"].entries()) {
        const sign = di ? -1 : 1;
        const runId = index * 2 + di;
        let t = 10 * (runId + 1);
        let v = 0;
        let pos = 0;
        for (let j = 0; j < 230; j++) {
          const dt = j % 2 ? 0.009 : 0.011;
          const voltage = sign * (index ? 6 : (t - 10 * (runId + 1)) * 2);
          const measured = v + (weak ? Math.sin(j * 0.7) * 0.35 : 0);
          lines.push({
            runId, test, direction, t, batt: 12, vL: voltage, vR: voltage,
            posL: pos, posR: pos, velL: measured, velR: measured,
          });
          v = stepVelocity(v, voltage, dt, gains);
          pos += v * dt;
          t += dt;
        }
      }
    }
    return lines;
  };
  const append = (target, rows) => {
    for (let i = 0; i < rows.length; i += 10)
      target.append(parseBatch("[SYSID]," + JSON.stringify(rows.slice(i, i + 10))));
  };
  append(capture, testRuns());
  assert.equal(capture.runs.size, 4);
  const runs = [...capture.runs.values()];
  const fit = fitChannel(runs, "drive-left");
  for (const key of Object.keys(gains)) assert.ok(Math.abs(fit.gains[key] - gains[key]) < 0.04, key);
  assert.ok(fit.simulation.rSquared > 0.99);

  const records = [];
  const serialRecords = [];
  const gt1 = (stamp, topic, value) => {
    const line = `GT1,${stamp >>> 0},${records.length},${topic},${value}`;
    records.push(line);
    if (!/^sysid\.(?:left|right)\./.test(topic)) serialRecords.push("[SYSID]," + line);
  };
  const wheelPair = (row, stamp, elapsed, dropRightPosition = false) => {
    for (const [side, suffix, offset] of [["left", "L", 0], ["right", "R", 1]]) {
      const values = {
        run_id: row.runId,
        test: Number(row.test === "dynamic"),
        direction: row.direction === "forward" ? 1 : -1,
        time_s: elapsed,
        command_volts: row[`v${suffix}`] * 1.1,
        volts: row[`v${suffix}`],
        position_m: row[`pos${suffix}`],
        mps: row[`vel${suffix}`],
      };
      for (const [field, value] of Object.entries(values)) {
        if (dropRightPosition && side === "right" && field === "position_m") continue;
        gt1(stamp + offset, `sysid.${side}.${field}`, value);
      }
      if (!dropRightPosition || side === "left") {
        const fields = [values.run_id, values.test, values.direction, elapsed.toFixed(3),
          ...Object.values(values).slice(4).map(value => value.toPrecision(8))];
        serialRecords.push(`[SYSID],GT1W,${(stamp + offset) >>> 0},${suffix},${fields.join(",")}`);
      }
    }
  };
  const gt1Rows = testRuns();
  const base = 0xfffffff0;
  gt1(base - 25, "robot.battery_volts", 12);
  gt1(base - 20, "sysid.session_id", 1);
  gt1(base - 15, "sysid.profile", 1);
  wheelPair({ ...gt1Rows[0], runId: 99 }, base - 10, 0);
  gt1(base - 5, "sysid.result", 1);
  for (const [i, row] of gt1Rows.entries()) {
    const profile = row.runId + 1;
    const stamp = base + Math.round((row.t - 10) * 1000);
    if (i % 230 === 0) {
      gt1(stamp - 2, "robot.battery_volts", 12);
      gt1(stamp - 1, "sysid.profile", profile);
    }
    wheelPair(row, stamp, row.t - 10 * profile, i === 12);
    if (i % 230 === 229) gt1(stamp + 2, "sysid.completed_profiles", profile);
  }
  gt1(base + 40_000, "sysid.profile", 1);
  wheelPair({ ...gt1Rows[0], runId: 100 }, base + 40_001, 0);
  const driveLab = new DriveLabCapture();
  for (const line of records) assert.equal(driveLab.receive(line), true);
  const importedDriveLab = parseDriveLabCapture(records.join("\r\n"));
  const liveDriveLab = new DriveLabCapture();
  for (const line of serialRecords) {
    assert.equal(isDriveLabRecord(line), true);
    assert.equal(liveDriveLab.receive(line), true);
  }
  assert.equal(isDriveLabRecord('[SYSID],{"runId":"custom"}'), false);
  assert.deepEqual([...parseDriveLabCapture(serialRecords.join("\n")).runs], [...liveDriveLab.capture.runs]);
  assert.deepEqual([...liveDriveLab.capture.runs.values()].map(run => [run.key, run.excluded, run.samples.length]),
    [...importedDriveLab.runs.values()].map(run => [run.key, run.excluded, run.samples.length]));
  assert.deepEqual([...driveLab.capture.runs], [...importedDriveLab.runs]);
  assert.equal(importedDriveLab.count, 2 * (gt1Rows.length - 1 + 2));
  const [aborted, ramp, ...later] = [...importedDriveLab.runs.values()];
  assert.equal(aborted.excluded, true);
  assert.equal(later.at(-1).excluded, true);
  assert.equal(ramp.excluded, false);
  assert.equal(ramp.samples[0].battery, 12);
  assert.equal(ramp.samples[0].time, base / 1000);
  assert.ok(ramp.samples[4].time > 0xffffffff / 1000);
  assert.equal(ramp.samples[3].commandVoltage, ramp.samples[3].voltage * 1.1);
  for (const side of ["drive-left", "drive-right"]) {
    const result = fitChannel([...importedDriveLab.runs.values()], side);
    for (const key of Object.keys(gains)) assert.ok(Math.abs(result.gains[key] - gains[key]) < 0.04, key);
    const liveResult = fitChannel([...liveDriveLab.capture.runs.values()], side);
    for (const key of Object.keys(gains)) assert.ok(Math.abs(liveResult.gains[key] - result.gains[key]) < 1e-5, key);
  }

  runs[0].excluded = true;
  assert.throws(() => fitChannel(runs, "drive-left"), /both directions/);
  const weak = new Capture();
  append(weak, testRuns(true));
  assert.ok(fitChannel([...weak.runs.values()], "drive-left").warnings.some(text => text.includes("acceleration R²")));

  const rankDeficient = new Capture();
  append(rankDeficient, testRuns().map(row => ({
    ...row, vL: 2, vR: 2, velL: row.direction === "forward" ? 1 : -1,
  })));
  assert.throws(() => fitChannel([...rankDeficient.runs.values()], "drive-left"), /cannot identify/);

  const newRun = new Capture();
  const validation = [];
  let v = 0;
  for (let i = 0; i < 180; i++) {
    const volts = i < 90 ? 4 : -4;
    validation.push({
      runId: "held-out", test: "validation", direction: "forward", t: 20 + i / 100,
      batt: i < 90 ? 12 : 10.5, vL: volts, dutyR: volts / (i < 90 ? 12 : 10.5),
      posL: 0, posR: 0, velL: v, velR: v, targetVelL: v + 0.25,
    });
    v = stepVelocity(v, volts, 0.01, gains);
  }
  append(newRun, validation);
  const independent = [...newRun.runs.values()][0];
  const rows = independent.samples.filter(row => row.channel === "drive-left");
  const metrics = predictionMetrics(simulate(rows, gains));
  assert.ok(metrics.model.rmse < 1e-10);
  assert.ok(Math.abs(metrics.tracking.bias + 0.25) < 1e-10);
  assert.equal(runHealth(independent).sag, 1.5);
  const broken = rows.map((row, i) => i > 10 ? { ...row, time: row.time + 1 } : row);
  assert.equal(predictionMetrics(simulate(broken, gains)).model.count, 10);
  assert.equal(predictionMetrics(simulate(rows.slice(0, 1), gains)).model, null);
  assert.notEqual(await runFingerprint(independent, "drive-left"), await runFingerprint(runs[0], "drive-left"));
  assert.equal(await runFingerprint(independent, "drive-left"),
    await runFingerprint({ ...independent, samples: independent.samples.map(row =>
      ({ ...row, runId: "renamed", time: row.time + 300 })) }, "drive-left"));
  assert.throws(() => append(newRun, validation.slice(0, 2)), /Time must increase/);
  assert.equal(newRun.count, 360, "invalid batches cannot partially mutate a capture");
  assert.throws(() => parseBatch(JSON.stringify({ ...validation[0], mode: "angular" })), /require gyro/);
  const { LiveConnection } = await server.ssrLoadModule("/live/LiveConnection.ts");
  const { LiveEvents } = await server.ssrLoadModule("/live/LiveEvents.ts");
  const { LiveSession } = await server.ssrLoadModule("/live/LiveSession.ts");
  const { LiveLineParser } = await server.ssrLoadModule("/live/LiveLineParser.ts");
  const originalWebSocket = globalThis.WebSocket;
  try {
    let socket;
    globalThis.WebSocket = class extends EventTarget {
      constructor() {
        super();
        socket = this;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
    };
    const session = new LiveSession();
    const events = new LiveEvents();
    const stream = { acceptingData: true, connectionOpened() {} };
    const live = new LiveConnection(session, events, {
      websocketUrl: "ws://127.0.0.1/ws", async resolveOrigin() {}, async waitUntilReady() { return true; },
    }, { valid: true }, stream, { playback: { pause() {} } }, new LiveLineParser());
    assert.ok(await live.connect());
    const fromSocket = new Capture();
    events.sysIdBatch.subscribe(line => fromSocket.append(parseBatch(line)));
    const batch = "[SYSID]," + JSON.stringify(validation.slice(0, 2));
    socket.dispatchEvent(new MessageEvent("message", { data: batch }));
    assert.equal(fromSocket.count, 4);
    assert.equal([...fromSocket.runs.values()][0].samples[2].time, validation[1].t);
    assert.equal(session.pending.pendingCount(), 0, "SysId batches stay outside the native replay buffer");
    stream.acceptingData = false;
    socket.dispatchEvent(new MessageEvent("message", { data: batch }));
    assert.equal(fromSocket.count, 4);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  const angular = parseBatch(JSON.stringify({
    ...validation[0], mode: "angular", gyro: 0.4, gyroRate: 2, currentL: 3, motorVelL: [2, 1],
  }));
  assert.equal(angular[0].gyroRate, 2);
  assert.deepEqual(angular[0].motorVelocities, [2, 1]);

  const csv = parseCapture("run_id,test,direction,time_s,motor,units,voltage,position,velocity\n1,dynamic,reverse,0.2,drive-left,in,-2,4,-8");
  assert.equal([...csv.runs.values()][0].samples[0].velocity, -0.2032);
  assert.throws(() => parseCapture("time,vel\n0,0"), /applied voltage/);
  assert.throws(() => parseCapture("run_id,test,direction,time_s,motor,units,voltage,position,velocity\n1,dynamic,reverse,0.2,drive-left,deg,-2,4,"), /velocity/);

  const [fixture, reference] = process.argv.slice(2);
  if (fixture && reference) {
    const real = parseCapture(readFileSync(fixture, "utf8"));
    const expected = JSON.parse(readFileSync(reference, "utf8")).channels;
    for (const name of real.units.keys()) {
      const fit = fitChannel([...real.runs.values()], name);
      const referenceFit = (expected[name] ?? expected[name.replace(/^drive-/, "")]).fit;
      for (const key of Object.keys(gains)) assert.ok(Math.abs(fit.gains[key] - referenceFit[key]) < 1e-8, `${name} ${key}`);
      assert.equal(fit.diagnostics.length, referenceFit.samples);
      assert.ok(Math.abs(fit.acceleration.rSquared - referenceFit.acceleration_r_squared) < 1e-8);
      console.log(name, fit.gains, "velocity R²", fit.simulation.rSquared);
    }
  }
  console.log("SysId capture, fit, and held-out validation regressions passed.");
} finally {
  await server.close();
}
