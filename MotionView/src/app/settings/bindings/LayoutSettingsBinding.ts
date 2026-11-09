import type { ViewingLayoutView } from "../../../viewing/render/ViewingLayoutView";
import type { SettingsFeature } from "../SettingsFeature";

function cssNumber(property: string, fallback: number): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(property),
  );
  return Number.isFinite(value) ? value : fallback;
}

export class LayoutSettingsBinding {
  constructor(
    private readonly settings: SettingsFeature,
    private readonly viewing: ViewingLayoutView,
  ) {}

  apply(): void {
    const value = this.settings.current;
    this.viewing.applyPersistedLayout({
      leftSidebarWidth: value.layoutLeftSidebarWidth,
      sidebarWidth: value.layoutRightSidebarWidthViewing,
      timelineHeight: value.layoutTimelineHeight,
    });
  }
  capture(): void {
    this.settings.update(
      {
        layoutLeftSidebarWidth: cssNumber("--leftSidebarW", 360),
        layoutRightSidebarWidthViewing: cssNumber(
          "--rightSidebarWViewing",
          370,
        ),
        layoutTimelineHeight: cssNumber("--timelineH", 180),
      },
      "system",
    );
  }
}
