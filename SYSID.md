# Drivetrain SysId

Select the **SysId** tab in GuanTrace to open the full-window workspace. **Profile** accepts guanid CSV or live captures. Select a run to inspect its left and right traces, sample rate, and battery sag. Exclude runs with collisions, interruptions, or excessive voltage drop before fitting. Select **Fit gains** after collecting forward and reverse quasistatic and dynamic linear tests.

The fitter uses measured applied voltage and derives acceleration from raw velocity on the recorded time grid. It applies a five-sample median and a local quadratic derivative within each run. It reports acceleration R² separately from the velocity simulation metrics. The voltage residual is measured minus fitted voltage. The model and tracking errors are also measured minus their respective reference. Hover the plots to inspect individual points. [WPILib SysId diagnostics](https://docs.wpilib.org/en/latest/docs/software/advanced-controls/system-identification/viewing-diagnostics.html)

## Live capture

Open **SysId**, start the stream if needed, and select **Capture PROS**. Brain, Viewing, and SysId share the stream and robot terminal. Run the robot's characterization or feedforward test using its normal operator controls. After stopping collection, **Save capture** saves a log that can be imported in either view.

### DriveLab

For live motor and sensor graphs, set **Settings → PROS Directory** to `firmware/drive-lab`, open **Brain**, and select **Start stream**. Choose a device by its Smart Port number.

For live SysID, select **Capture PROS** before starting the first profile. DriveLab tags wheel samples and run metadata with `[SYSID],`. GuanTrace pairs left and right samples, uses robot uptime for the time axis, and plots requested voltage as a dashed trace alongside measured voltage. The fit uses measured voltage. Cancelled attempts and attempts without a completion marker are excluded by default.

After running the four profiles, stop the capture and select **Fit gains**. **Save capture** writes a `.gt1` file. You can also open a `drive-lab-*.gt1` file from the Brain's SD card via **Import capture**.

### Custom PROS emitters

Emit one newline-terminated plain-text record per batch. The following record shows the fields and units. The payload can be an object or an array of sample objects.

```text
[SYSID],[{"runId":"r1","test":"quasistatic","direction":"forward","mode":"linear","t":12.01,"batt":12.1,"vL":1.8,"vR":1.8,"posL":0.4,"posR":0.4,"velL":0.6,"velR":0.59}]
```

- Set `t` to the robot's sample time in seconds. Use a new run ID for each test attempt or clock reset. Send samples in chronological order within each run. Batch a few samples at a time at the robot's sample rate. Keep each batch below 64 KiB and at most 128 records.
- Use volts for `vL`, `vR`, and `batt`, metres for `posL` and `posR`, and raw metres per second for `velL` and `velR`. If measured controller voltage is unavailable, send signed `dutyL` or `dutyR` in place of the corresponding voltage. The app multiplies duty by the sampled battery voltage.
- Set `test` to `quasistatic`, `dynamic`, or `validation` and `direction` to `forward` or `reverse`. For `mode: "angular"`, also send `gyro` in radians and `gyroRate` in radians per second. Angular runs are captured for inspection. The fit and saved-model comparison use linear runs.
- Optional targets are `targetVelL` and `targetVelR` in m/s, and `targetPosL` and `targetPosR` in m. Optional diagnostics are `currentL` and `currentR` in amps and `motorVelL` and `motorVelR` as arrays of per-motor velocity in m/s at the wheel.
- For offline JSON Lines files, the `[SYSID],` prefix is optional. The paired guanid CSV can also carry `left_target_velocity_mps`, `right_target_velocity_mps`, `left_target_position_m`, `right_target_position_m`, and `battery_volts`.

## WPILOG and NetworkTables

- For a WPILOG, choose **Import capture** and select the `.wpilog` file. The mapping form lists compatible entries for each signal. Map applied voltage and wheel velocity on both sides. Map the SysId state string for profiling, usually `sysid-test-state-<mechanism>`. A capture without mapped state opens as one validation run. [WPILib SysId log loader](https://docs.wpilib.org/en/stable/docs/software/advanced-controls/system-identification/loading-data.html)
- In the desktop app, choose **Connect NT4**, enter the server host or IP, and enter exact topic paths starting with `/`. The default port is 5810. The bridge subscribes to the mapped topics and requests all updates. Publish each wheel voltage and velocity at every sample, including repeated values. Use `keepDuplicates` on the robot publisher if necessary. **Stop NT4 capture** keeps the capture in the active SysId view. **Save capture** writes an importable log. [WPILib publish and subscribe](https://docs.wpilib.org/en/stable/docs/software/networktables/publish-and-subscribe.html)
- Use applied volts and wheel velocity in m/s. Optional fields include wheel position, target velocity, battery, gyro, and a `struct:Pose2d` or three-value float/double array in metres, metres, and radians. Use `quasistatic-forward`, `quasistatic-reverse`, `dynamic-forward`, `dynamic-reverse`, or `validation` for run state. Use `none` between runs. For a spin, prefix the state with `angular-` and map both gyro channels.
- Record the required signals on the same robot clock. The mapper uses the left-velocity timestamp and pairs fresh required samples within 4 ms. It skips unmatched rows and reports missing signals. A lost NT4 connection keeps earlier runs and excludes the interrupted run. You can review that run and change its exclusion.
- In **Validate**, select **Open mapped pose route** to load the mapped poses in **Viewing** and link their timeline to the run. The pose conversion preserves the WPILib origin, converts metres to inches, and converts heading to MotionView's convention. The field uses MotionView's currently selected artwork.

## Check gains on the robot

1. In **Profile**, select **Save gains** to store the current fit on this device.
2. On the robot, disable velocity feedback and run a separate trapezoid or stepped speed profile with `kS·sign(v) + kV·v + kA·a`. Use an operator-controlled stop. Log target velocity, measured wheel velocity, and actual applied voltage for each side on the same clock. [WPILib characterization procedure](https://docs.wpilib.org/en/latest/docs/software/advanced-controls/system-identification/running-routine.html)
3. Open **Validate**, import or stream the independent run, and select **Compare with saved gains**. The simulation starts from the measured velocity at the beginning of each run, holds applied voltage from each sample to the next, and stops at gaps over 100 ms. It excludes the starting velocity from model error. The target tracking comparison uses logged setpoints when available.
4. If you have poses from the same run, load the route in **Viewing**. Open **Sync with field replay** in **Validate** and enter the offset such that `replay ms = sample seconds × 1000 + offset ms`. Select **Link replay**, then click the plot or enter a time and select **Seek**. Switch to **Viewing** to inspect the selected pose. Moving the replay cursor also updates the marker when you return to **SysId**.

For a run collected with feedback active, the simulation uses the applied voltage after controller action. The target overlay shows the observed tracking performance of that controller. An exact copy of a training run is rejected even if it was renamed or its timestamps shifted. Capture a genuinely separate run for validation.

Run the numerical and capture regression suite from `MotionView/` with `pnpm run test:sysid`. Optional CSV and reference JSON arguments compare the fit with the guanid analyzer in SI units.

Run `pnpm run test:wpilib` for the alignment and interruption checks. To generate a WPILOG and an actual NT4 session transcript, install the bridge requirements and `pyntcore` in a Python environment, then run:

```sh
fixture_dir=$(mktemp -d)
python scripts/tests/wpilib_fixture.py "$fixture_dir"
pnpm run test:wpilib "$fixture_dir"
```
