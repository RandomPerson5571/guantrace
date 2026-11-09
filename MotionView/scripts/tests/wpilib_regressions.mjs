import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";

const server = await createServer({
  configFile: "vite.config.js", logLevel: "error",
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
});
try {
  const { WpiLog } = await server.ssrLoadModule("/sysid/wpilog.ts");
  const { SignalCapture } = await server.ssrLoadModule("/sysid/signals.ts");
  const { parseCapture } = await server.ssrLoadModule("/sysid/capture.ts");
  const { fitChannel } = await server.ssrLoadModule("/sysid/model.ts");
  const mapping = {
    vL: "/vL", vR: "/vR", velL: "/velL", velR: "/velR",
    posL: "/posL", posR: "/posR", state: "/state", pose: "/pose",
  };

  assert.throws(() => new WpiLog(new ArrayBuffer(4)), /WPILOG header/);
  assert.throws(() => new SignalCapture({ velL: "/velL" }), /Map left applied voltage/);
  const partial = new SignalCapture(mapping);
  partial.receive({ name: "/state", us: 1, value: "quasistatic-forward" });
  partial.receive({ name: "/velL", us: 100_000, value: 3 });
  partial.receive({ name: "/vL", us: 100_000, value: 2 });
  partial.drain(true);
  assert.equal(partial.capture.count, 0);
  assert.match(partial.diagnostic(), /Right applied voltage/);
  assert.match(partial.diagnostic(), /Skipped 1/);

  const running = new SignalCapture(mapping);
  running.receive({ name: "/state", us: 100_000, value: "dynamic-forward" });
  for (const us of [101_000, 111_000, 301_000]) {
    // Topic delivery order differs from source timestamp order.
    running.receive({ name: "/velL", us, value: 1.5 });
    running.receive({ name: "/velR", us: us + 200, value: 1.6 });
    running.receive({ name: "/vL", us: us - 200, value: 4 });
    running.receive({ name: "/vR", us: us + 100, value: 4.1 });
    running.receive({ name: "/state", us: us + 50, value: "dynamic-forward" });
  }
  running.drain();
  assert.equal(running.capture.count, 4);
  assert.equal([...running.capture.runs.values()][0].samples[0].time, .101);
  running.receive({ name: "/velL", us: 110_000, value: 5 });
  running.drain(true);
  assert.equal(running.late, 1);
  assert.equal(running.capture.count, 6, "drain on stop preserves the alignment window tail");
  assert.equal(running.interrupt(), true);
  const saved = parseCapture(running.exportLines().join("\n"));
  assert.equal(saved.count, 6);
  assert.equal([...saved.runs.values()][0].excluded, true, "interrupted runs remain excluded after reimport");

  const fixture = process.argv[2];
  if (fixture) {
    const bytes = readFileSync(join(fixture, "drive.wpilog"));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.throws(() => new WpiLog(buffer.slice(0, -1)), /truncated/);
    const log = new WpiLog(buffer);
    assert.equal(log.entries.length, 8);
    assert.throws(() => log.read(new Set(["/missing"]), () => {}), /missing/);
    const offline = new SignalCapture(mapping);
    log.read(offline.names, event => offline.receive(event));
    offline.drain(true);
    assert.equal(offline.capture.runs.size, 4);
    assert.equal(offline.capture.count, 1278);
    assert.equal(offline.skipped, 1);
    assert.equal(offline.capture.poses.length, 640);
    assert.equal(offline.capture.poses[0].time, 1.0009);
    const fit = fitChannel([...offline.capture.runs.values()], "drive-left");
    for (const [key, expected] of Object.entries({ kS: .3, kV: 2.2, kA: .5 }))
      assert.ok(Math.abs(fit.gains[key] - expected) < .04, key);
    const live = new SignalCapture(mapping);
    for (const event of JSON.parse(readFileSync(join(fixture, "nt4-events.json"), "utf8"))) live.receive(event);
    live.drain();
    assert.ok(live.capture.count > 0);
    live.drain(true);
    assert.equal(live.capture.count, 60);
    assert.equal(live.capture.poses.length, 30);
    assert.equal(live.interrupt(), true);
    const roundTrip = parseCapture(live.exportLines().join("\n"));
    assert.equal(roundTrip.count, 60);
    assert.deepEqual(roundTrip.poses, live.capture.poses);
    assert.equal([...roundTrip.runs.values()][0].excluded, true);
  }
  console.log("WPILOG and NT4 alignment, diagnostics, and capture regressions passed.");
} finally {
  await server.close();
}
