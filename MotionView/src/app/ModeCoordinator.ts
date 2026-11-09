import type { MotionViewApp } from "./MotionViewApp";
import type { FieldRenderer } from "../render/field";
import type { ViewingLayoutView } from "../viewing/render/ViewingLayoutView";
import { appTelemetry } from "../telemetry/createTelemetry";

export class ModeCoordinator {
  #bound = false;
  constructor(
    private readonly app: MotionViewApp,
    private readonly field: FieldRenderer,
    private readonly viewing: ViewingLayoutView,
  ) {}
  bind(): void {
    if (this.#bound) return;
    this.#bound = true;
    this.app.core.mode.subscribeMode((mode) => {
      const showField = mode === "viewing";
      document.body.classList.toggle("fieldWorkspaceHidden", !showField);
      if (!showField) {
        this.app.viewing.playback.pause();
        return;
      }
      this.viewing.activate();
      this.field.updateFieldLayout(true);
      void appTelemetry.modeChanged({ mode });
    });
  }
}
