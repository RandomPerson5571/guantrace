import type { MotionViewApp } from "../MotionViewApp";
import type { MotionViewDocumentSerializer } from "../persistence";
import { exportMotionViewJson } from "../../tauri/commands";
import { exportTelemetry } from "../../telemetry/createTelemetry";
import type { ExportRequest } from "./exportTypes";
import { stringifyExportJson } from "./exportJson";

export class ExportService {
  constructor(
    private readonly app: MotionViewApp,
    private readonly serializer: MotionViewDocumentSerializer,
  ) {}
  async export(
    request: Readonly<ExportRequest>,
    overwrite = false,
  ): Promise<Readonly<{ path: string; json: string }>> {
    const payload = this.serializer.exportPayload(
      request.pathName,
      this.app.settings.current,
    );
    const json = stringifyExportJson(payload);
    const result = await exportMotionViewJson({
      filenameBase: request.filenameBase,
      location: request.destination.kind,
      customPath: request.destination.customPath,
      jsonContents: json,
      overwrite,
    });
    void exportTelemetry.motionviewJsonExported({
      export_type: "viewing",
      includes_planning: false,
      includes_viewing: true,
      export_location: request.destination.kind,
      exported_viewing_poses: this.app.viewing.data.poses.length,
      exported_viewing_watches: this.app.viewing.data.watches.length,
      exported_viewing_logs: this.app.viewing.data.logs.length,
      exported_viewing_waypoints: this.app.viewing.data.waypoints.length,
    });
    return { path: result.path, json };
  }
}
