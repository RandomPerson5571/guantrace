export type ImportedFileType = "json" | "text";

export interface RouteImportResult {
  readonly type: ImportedFileType;
  readonly loaded: boolean;
}
