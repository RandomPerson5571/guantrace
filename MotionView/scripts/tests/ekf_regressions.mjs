import assert from "node:assert/strict";
import { createServer } from "vite";
const server = await createServer({ configFile: "vite.config.js", logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { parseInnovation, consistency, chiSquareQuantile } = await server.ssrLoadModule("/ekf/diagnostics.ts");
  const { parseDescriptor } = await server.ssrLoadModule("/brain/signalDescriptor.ts");
  const { ViewingFeature } = await server.ssrLoadModule("/viewing/ViewingFeature.ts");
  const row = parseInnovation("GTE1,100,1,8,0,2,4,0,1,2,3,4,5,6");
  assert.equal(row.gain.length, 6);
  assert.equal(row.accepted, false);
  assert.equal(consistency([row]).meanNis, 1);
  assert.equal(consistency([row]).rejected, 1);
  for (const line of ["GTE1,100,1,8,0,2,0,0,1,2,3,4,5,6", "GTE1,100,1,8,0,2,4,2,1,2,3,4,5,6", "GTE1,100,1,8,99,2,4,0,1,2,3,4,5,6", "GTE1,100,1,8,0,2,4,0,1,2,3,4,5,", "GTE1,100,1,8,0,NaN,4,0,1,2,3,4,5,6"]) assert.equal(parseInnovation(line), null, line);
  // Published chi-square reference quantiles; includes large-N average bounds.
  for (const [p, df, expected] of [[.025, 1, .000982069117175], [.975, 1, 5.023886187315], [.025, 2, .05063561596858], [.975, 2, 7.377758908228], [.975, 100, 129.5611971858]]) {
    assert.ok(Math.abs(chiSquareQuantile(p, df) - expected) < 1e-7);
  }
  const constant = consistency(Array.from({ length: 100 }, (_, i) => ({ ...row, sequence: i })));
  assert.equal(constant.acf[0].y, null); // zero variance is undefined, not white
  assert.ok(constant.averageLower < 1 && constant.averageUpper > 1);
  const alternating = consistency(Array.from({ length: 100 }, (_, i) => ({ ...row, residual: i % 2 ? -2 : 2 })));
  assert.ok(alternating.acf[0].y < -.98);
  assert.equal(alternating.meanResidual, 0);
  assert.equal(alternating.coverage, 1);
  assert.equal(consistency([]), null);
  assert.equal(parseDescriptor("GTD1,0,input.controller.left_x,controller,0,counts,int32,100").period, 100);
  assert.equal(parseDescriptor("GTD1,0,device.motor.1.rpm,motor,1,rpm,float64,100").unit, "rpm");
  assert.equal(parseDescriptor("GTD1,0,<script>,motor,1,rpm,float64,100"), null);
  assert.equal(parseDescriptor("GTD1,0,a,motor,99,rpm,float64,100"), null);
  const view = new ViewingFeature();
  view.load({ poses: [{ t: 0, x: 1, y: 2, theta: 0 }], watches: [{ t: 0, id: 1, label: "x", value: 1 }], logs: [{ t: 0, message: "keep" }] });
  assert.equal(view.data.watches.length, 1);
  const poses = view.data.poses.length, logs = view.data.logs.length;
  view.clearWatches();
  assert.equal(view.data.watches.length, 0);
  assert.equal(view.projection.watchMarkers.length, 0);
  assert.equal(view.data.poses.length, poses);
  assert.equal(view.data.logs.length, logs);
  view.appendLiveBatch({ watches: [{ t: 1, id: 1, label: "x", value: 2 }] });
  assert.equal(view.data.watches.length, 1);
  assert.equal(view.projection.watchMarkers.length, 1);
  console.log("EKF statistics, descriptor validation, and watch clearing regressions passed.");
} finally { await server.close(); }
