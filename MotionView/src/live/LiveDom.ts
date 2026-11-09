function element<T extends HTMLElement>(root: Document, id: string): T | null {
  return root.getElementById(id) as T | null;
}

export class LiveDom {
  private constructor(
    readonly startStopButton: HTMLButtonElement | null,
    readonly sysIdStreamButton: HTMLButtonElement | null,
    readonly ekfStreamButton: HTMLButtonElement | null,
    readonly refreshButton: HTMLButtonElement | null,
    readonly refreshInterval: HTMLSelectElement | null,
    readonly console: HTMLElement | null,
    readonly viewingTerminalOutput: HTMLElement | null,
    readonly brainTerminalOutput: HTMLElement | null,
    readonly sysIdTerminalOutput: HTMLElement | null,
    readonly ekfTerminalOutput: HTMLElement | null,
    readonly fileButton: HTMLButtonElement | null,
    readonly playButton: HTMLButtonElement | null,
    readonly projectInput: HTMLInputElement | null,
    readonly autoDetectButton: HTMLButtonElement | null,
    readonly projectStatus: HTMLElement | null,
    readonly autoStatus: HTMLElement | null,
    readonly autoResults: HTMLElement | null,
  ) {}

  static from(root: Document = document): LiveDom {
    return new LiveDom(
      element(root, "btnLeftStream"),
      element(root, "sysidStream"),
      element(root, "ekfStream"),
      element(root, "btnLeftRefresh"),
      element(root, "leftRefreshInterval"),
      element(root, "liveWin"),
      element(root, "viewingTerminalOutput"),
      element(root, "brainTerminalOutput"),
      element(root, "sysidTerminalOutput"),
      element(root, "ekfTerminalOutput"),
      element(root, "btnFile"),
      element(root, "btnPlay"),
      element(root, "prosDirInput"),
      element(root, "btnProsDirAuto"),
      element(root, "prosDirStatus"),
      element(root, "prosDirAutoStatus"),
      element(root, "prosDirAutoResults"),
    );
  }
}
