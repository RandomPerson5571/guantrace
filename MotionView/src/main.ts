import { ConfirmationDialog } from "./app/dialogs/ConfirmationDialog";
import { EkfView } from "./ekf/EkfView";
import { SysIdView } from "./sysid/SysIdView";
import { BrainView } from "./brain/BrainView";
import demoRouteUrl from "./assets/demo/getting-started-route.json?url";
import { initializeMotionViewApp } from "./app/appRuntime";
import { HelpDom, HelpView } from "./app/help";
import { AppCommands, AppInput } from "./app/input";
import { RouteImportService } from "./app/import";
import { AppBootstrap, AppShutdown } from "./app/lifecycle";
import { ModeCoordinator } from "./app/ModeCoordinator";
import { MotionViewDocumentSerializer, SessionPersistence } from "./app/persistence";
import { ExportDialog, ExportDom, ExportService } from "./app/export";
import { RouteInfoDom, RouteInfoView } from "./app/routeInfo";
import {
  FieldSettingsBinding,
  LayoutSettingsBinding,
  LiveSettingsBinding,
  SettingsDom,
  SettingsView,
  TelemetrySettingsBinding,
  ViewingSettingsBinding,
} from "./app/settings";
import { TopBarDom, TopBarView } from "./app/topBar";
import { WindowController } from "./app/window";
import { installGlobalErrorReporting } from "./app/globalErrors";
import { requiredElement } from "./dom/elements";
import { LiveDom, LiveInput, LiveView } from "./live";
import { FieldRenderer } from "./render/field";
import {
  configureRenderScheduler,
  registerViewingRenderLayer,
} from "./render/renderScheduler";
import { ViewingDom, ViewingInput, ViewingView } from "./viewing";
import { ViewingLayoutView } from "./viewing/render/ViewingLayoutView";

const app = initializeMotionViewApp();
installGlobalErrorReporting(app.core.bridge);

const fieldRenderer = new FieldRenderer(requiredElement("c", HTMLCanvasElement, document));
fieldRenderer.bindInput();

const topBar = new TopBarView(app, fieldRenderer, TopBarDom.from());

const viewingView = new ViewingView(app.viewing, fieldRenderer, ViewingDom.from());
const viewingInput = new ViewingInput(app.viewing, viewingView);
const liveView = new LiveView(app.live, LiveDom.from());
const liveInput = new LiveInput(app.live);

const viewingLayout = new ViewingLayoutView(fieldRenderer, viewingView);

const settingsDom = SettingsDom.from();
const windowController = new WindowController();
const settingsView = new SettingsView(fieldRenderer, settingsDom);
const fieldSettings = new FieldSettingsBinding(app.settings, fieldRenderer, topBar, settingsDom);
const viewingSettings = new ViewingSettingsBinding(app.settings, app.viewing, settingsDom);
const liveSettings = new LiveSettingsBinding(app.settings, app.live);
const layoutSettings = new LayoutSettingsBinding(app.settings, viewingLayout);
const telemetrySettings = new TelemetrySettingsBinding(app.settings, app.core.telemetry.telemetryClient, settingsDom);

const confirmationDialog = new ConfirmationDialog();
const serializer = new MotionViewDocumentSerializer(app);
const helpView = new HelpView(app, HelpDom.from(), serializer);
const persistence = new SessionPersistence(app, serializer);
const importer = new RouteImportService(app, topBar, demoRouteUrl);
const exportDialog = new ExportDialog(app, ExportDom.from(), new ExportService(app, serializer), confirmationDialog);
const routeInfoView = new RouteInfoView(app, RouteInfoDom.from());

const appCommands = new AppCommands(app, fieldRenderer, topBar, viewingLayout);
const appInput = new AppInput(appCommands);
const modeCoordinator = new ModeCoordinator(app, fieldRenderer, viewingLayout);
const shutdown = new AppShutdown(app, fieldRenderer, persistence);
const bootstrap = new AppBootstrap(
  app,
  fieldRenderer,
  topBar,
  fieldSettings,
  viewingSettings,
  liveSettings,
  layoutSettings,
  telemetrySettings,
  persistence,
  importer,
  viewingLayout,
  confirmationDialog,
);

configureRenderScheduler({ drawField: () => fieldRenderer.draw() });
fieldRenderer.registerViewingLayer(viewingView.fieldLayer);
registerViewingRenderLayer(viewingView.timelineLayer);

confirmationDialog.bind();
viewingView.bind();
viewingInput.bind();
liveView.bind();
liveInput.bind();
new SysIdView(app.live.events, app.viewing, app.core.bridge);
new EkfView(app.live.events);
new BrainView(app.live);
viewingLayout.bind();
settingsView.bind();
topBar.bind();
helpView.bind();
exportDialog.bind();
routeInfoView.bind();
appInput.bind();
modeCoordinator.bind();
windowController.bind();
persistence.bind();
importer.bindFileDrop();

viewingLayout.changed.subscribe(() => layoutSettings.capture());
settingsView.robotImageRequested.subscribe(() => topBar.openRobotImagePicker());
settingsView.customFieldImageRequested.subscribe(() => topBar.openCustomFieldImagePicker());
topBar.events.actionRequested.subscribe((action) => {
  if (action.kind === "native-route-file-requested") void importer.openNativeFile();
  else if (action.kind === "file-selected") void importer.openFile(action.file, action.input);
  else if (action.kind === "robot-image-selected") void fieldSettings.handleRobotImageFile(action.file, action.input);
  else if (action.kind === "custom-field-image-selected") void fieldSettings.handleCustomFieldImageFile(action.file, action.input);
  else if (action.kind === "clear-requested") appCommands.clearCurrent();
  else if (action.kind === "settings-requested") {
    if (app.live.project.path && !app.live.project.valid) void app.live.project.validate();
    settingsView.open();
  } else if (action.kind === "help-requested") helpView.open();
});

viewingView.render();
await shutdown.bind();
await bootstrap.start();
await shutdown.ready();
