import { requiredElement } from "../dom/elements";
import { fieldAccepts, fields, type Mapping } from "./signals";
import type { WpiLog } from "./wpilog";

export class SignalMappingView {
  readonly #panel = requiredElement("sysidMapping", HTMLFormElement);
  readonly #host = requiredElement("sysidNt4Host", HTMLInputElement);
  readonly #hostRow = requiredElement("sysidNt4HostRow", HTMLElement);
  readonly #fields = requiredElement("sysidMappingFields", HTMLElement);
  readonly #action = requiredElement("sysidMapApply", HTMLButtonElement);
  #log: WpiLog | null = null;
  #ntMapping: Mapping = {};

  constructor(apply: (log: WpiLog | null, mapping: Mapping, host: string) => void) {
    this.#panel.addEventListener("submit", event => {
      event.preventDefault();
      const mapping: Mapping = {};
      const data = new FormData(this.#panel);
      for (const [key] of fields) {
        const value = data.get(key);
        if (typeof value === "string" && value.trim()) mapping[key] = value.trim();
      }
      if (!this.#log) this.#ntMapping = mapping;
      apply(this.#log, mapping, this.#host.value.trim());
    });
    requiredElement("sysidMapCancel", HTMLButtonElement).addEventListener("click", () => this.close());
  }

  open(log: WpiLog | null): void {
    this.#log = log;
    this.#panel.hidden = false;
    this.#hostRow.hidden = log !== null;
    this.#host.required = log === null;
    this.#action.textContent = log ? "Import mapped signals" : "Connect and capture";
    this.#fields.replaceChildren(...fields.map(([key, text, kind, required]) => {
      const label = document.createElement("label");
      label.textContent = text;
      let control: HTMLInputElement | HTMLSelectElement;
      if (log) {
        control = document.createElement("select");
        const entries = log.entries.filter(entry => fieldAccepts(kind, entry.type));
        control.append(new Option(required ? "Choose entry" : "Skip", ""));
        for (const entry of entries) control.append(new Option(entry.name, entry.name));
      } else {
        control = document.createElement("input");
        control.placeholder = "/topic";
        control.maxLength = 256;
        control.value = this.#ntMapping[key] ?? "";
      }
      control.name = key;
      control.required = required;
      label.append(control);
      return label;
    }));
    (log ? this.#fields.querySelector("select") : this.#host)?.focus();
  }

  close(): void {
    this.#panel.hidden = true;
    this.#fields.replaceChildren();
    this.#log = null;
  }
}
