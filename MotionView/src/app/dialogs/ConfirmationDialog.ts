import { requiredElement } from "../../dom/elements";
import { bindModalBackdropDismissal } from "./modalDismissal";

interface ConfirmationOptions {
  readonly title?: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly hideCancel?: boolean;
  readonly showDontShowAgain?: boolean;
}

interface ConfirmationResult {
  readonly confirmed: boolean;
  readonly dontShowAgain: boolean;
}

export class ConfirmationDialog {
  readonly #modal = requiredElement("confirmDialogModal", HTMLElement, document);
  readonly #title = requiredElement("confirmDialogTitle", HTMLElement, document);
  readonly #message = requiredElement("confirmDialogMessage", HTMLElement, document);
  readonly #close = requiredElement("btnConfirmDialogClose", HTMLButtonElement, document);
  readonly #cancel = requiredElement("btnConfirmDialogCancel", HTMLButtonElement, document);
  readonly #confirm = requiredElement("btnConfirmDialogConfirm", HTMLButtonElement, document);
  readonly #checkbox = requiredElement("confirmDialogDontShowAgain", HTMLInputElement, document);
  readonly #checkboxRow = requiredElement("confirmDialogDontShowAgainRow", HTMLElement, document);
  #resolve: ((result: ConfirmationResult) => void) | null = null;

  bind(): void {
    this.#close.addEventListener("click", () => this.finish(false));
    this.#cancel.addEventListener("click", () => this.finish(false));
    this.#confirm.addEventListener("click", () => this.finish(true));
    bindModalBackdropDismissal(this.#modal, () => this.finish(false));
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.#resolve) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.finish(false);
    }, true);
  }

  async confirm(options: ConfirmationOptions): Promise<boolean> {
    return (await this.confirmWithResult(options)).confirmed;
  }

  confirmWithResult(options: ConfirmationOptions): Promise<ConfirmationResult> {
    this.finish(false);
    this.#title.textContent = options.title ?? "Confirm";
    this.#message.textContent = options.message;
    this.#confirm.textContent = options.confirmLabel ?? "Confirm";
    this.#cancel.hidden = options.hideCancel === true;
    this.#checkbox.checked = false;
    this.#checkboxRow.hidden = options.showDontShowAgain !== true;
    this.#modal.hidden = false;
    this.#modal.style.display = "flex";
    this.#modal.querySelector<HTMLElement>(".modalCard")?.focus();
    return new Promise((resolve) => { this.#resolve = resolve; });
  }

  private finish(confirmed: boolean): void {
    if (!this.#resolve) return;
    const dontShowAgain = confirmed && !this.#checkboxRow.hidden && this.#checkbox.checked;
    const resolve = this.#resolve;
    this.#resolve = null;
    this.#modal.hidden = true;
    this.#modal.style.display = "none";
    resolve({ confirmed, dontShowAgain });
  }
}
