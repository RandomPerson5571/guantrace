# Telemetry diagnostics

The firmware's service task writes ordered device declarations (`GTD1`), numeric
samples (`GT1`), and complete EKF scalar updates (`GTE1`). The PROS terminal passes
text records to the Python bridge. Its bounded broadcast queue batches adjacent
telemetry without moving records across control messages. LiveConnection routes
specifications/EKF updates to diagnostics and preserves existing device, watch,
and SysId routing. Queue overflow is reported in the terminal; EKF sequence gaps
are counted in the diagnostic view.

Brain → Signal specifications shows firmware-supplied topic, device/port, type,
units, nominal acquisition period and latest value. Specifications refresh every
second and on device changes. Existing firmware without descriptors continues to
use known device-topic parsing. Application-specific ADI, vision and serial
channels still need publishers; presence is not a promise of graph support.

SysId remains separate because motor characterization needs capture management,
fitting, residual plots, and held-out validation. R² appears for fitting and
validation; undefined R² (constant measured data) displays “—”. Trial gains preview
a simulation without overwriting saved gains. Switching capture/page clears trial
gains. “Save gains” continues to save fitted gains only.

EKF diagnostics has its own EKF tab in the top app bar. It supports live capture, bounded history,
file import/export, view pause, per-measurement selection and these plots:

- Innovation and ±3√S, with rejected updates marked by crosses.
- NIS and two-sided 95% chi-square bounds, plus mean-NIS bounds in the summary.
- Normalized innovation autocorrelation at up to 40 nonzero sample lags and
  approximate ±1.96/√N reference bands. Constant signals have undefined ACF.
- All six candidate Kalman gains, including gains not applied after rejection.

Current firmware performs scalar measurement updates, so each source uses m=1.
The summary uses χ²(N)/N for average NIS, not the single-sample interval. Sources
and reset epochs are not pooled. Full precision and complete records avoid
mixing residuals, S and gains between updates. The UI resets on stream start and
estimator reset, ignores duplicate/out-of-order sequence numbers, unwraps millis,
and reports invalid/missing records. It retains 6,000 total updates and analyzes
up to 1,200 of the selected source. Import keeps only the newest reset epoch.

Statistics include NIS-gated rejections. Measurements rejected before a valid
innovation exists are absent. Correlation, geometry gates, slip selection and
loss affect the interpretation of nominal confidence bounds. High mean NIS can
indicate underestimated noise or model bias; low NIS can indicate inflated noise.
Check bias and autocorrelation before tuning Q/R; these statistics cannot uniquely
identify both. They require no ground truth.

The chi-square quantiles use numerical inversion of the regularized gamma CDF,
with reference-value regression tests. See the
[NIST chi-square distribution reference](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3666.htm).

## Record formats

```text
GTD1,time_ms,topic,device_kind,port,unit,type,period_ms
GTE1,time_ms,reset_epoch,sequence,source,residual,S,accepted,Kx,Ky,Kheading,Kvelocity,Kyaw,Kbias
```

Source 0 = IMU heading (rad); 1 = gyro bias (rad/s); 2 + port = distance (m).
`S` is innovation variance including cross-correlation where the filter uses it.
`accepted` is 0/1. Gain components use state SI units divided by measurement SI
units. Device ports are 1–21; controller descriptors use port 0. Types are
`float64`, `int32`, or `bool`. Each record is validated before use.

Watches → Clear watches removes watch history and associated graph/selection
state while retaining route poses, logs, waypoints and the active stream.
