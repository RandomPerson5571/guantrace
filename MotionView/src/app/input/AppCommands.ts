import type { MotionViewApp } from "../MotionViewApp";
import type { TopBarView } from "../topBar";
import type { ViewingLayoutView } from "../../viewing/render/ViewingLayoutView";
import type { FieldRenderer } from "../../render/field";

/** Executes application-wide commands that coordinate more than one feature. */
export class AppCommands {
  constructor(
    private readonly app: MotionViewApp,
    private readonly field: FieldRenderer,
    private readonly topBar: TopBarView,
    private readonly viewingLayout: ViewingLayoutView,
  ) {}

  openRoute(): void {
    this.topBar.openFilePicker();
  }
  fitField(): void {
    if (this.app.core.mode.getMode() === "viewing")
      this.field.resetFieldPosition();
  }
  setViewingMode(): void {
    this.app.core.mode.setMode("viewing");
  }
  toggleTimeline(): void {
    if (this.app.core.mode.getMode() === "viewing")
      this.viewingLayout.toggleTimeline();
  }

  toggleLeftSidebar(): void {
    if (this.app.core.mode.getMode() === "viewing")
      this.viewingLayout.toggleLeftSidebar();
  }

  toggleRightSidebar(): void {
    if (this.app.core.mode.getMode() === "viewing")
      this.viewingLayout.toggleRightSidebar();
  }

  clearCurrent(): void {
    if (this.app.core.mode.getMode() !== "viewing") return;
    // A live stream stays active across a field clear. Keep the parser's
    // timestamp/session state so the next WebSocket records continue to be
    // accepted, while discarding records that were buffered before the clear.
    if (this.app.live.stream.streaming) this.app.live.clearActiveOutput();
    else this.app.live.reset();
    this.app.viewing.clear();
    this.app.core.status.setStatus("Cleared Field");
  }
}
