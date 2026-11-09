import { fields, fieldAccepts, SignalCapture } from "./signals";
import type { SignalEvent } from "./wpilog";

type Nt4Message =
  | { kind: "connected" }
  | { kind: "error"; message: string }
  | { kind: "topic"; name: string; type: string }
  | { kind: "samples"; values: SignalEvent[] };

export class Nt4Session {
  readonly #socket: WebSocket;
  readonly #timeout: number;
  readonly #refresh: number;
  #closed = false;
  #connected = false;

  constructor(url: string, host: string, readonly source: SignalCapture,
    private readonly update: (status: string) => void,
    private readonly finish: (status: string, interrupted: boolean) => void) {
    this.#socket = new WebSocket(url);
    this.#timeout = window.setTimeout(() => this.stop("The NT4 connection timed out.", true), 9000);
    this.#refresh = window.setInterval(() => this.flush(), 200);
    this.#socket.addEventListener("open", () => {
      this.#socket.send(JSON.stringify({ host, topics: [...source.names] }));
    });
    this.#socket.addEventListener("message", event => {
      if (this.#closed || typeof event.data !== "string") return;
      try {
        const message: Nt4Message = JSON.parse(event.data);
        if (message.kind === "connected") {
          this.#connected = true;
          window.clearTimeout(this.#timeout);
          this.flush();
        } else if (message.kind === "topic") {
          const field = fields.find(([key, , kind]) =>
            source.mapping[key] === message.name && !fieldAccepts(kind, message.type));
          if (field) this.stop(`Wrong NT4 type for ${field[1]}. Check the topic mapping.`, true);
        } else if (message.kind === "samples") {
          for (const value of message.values) source.receive(value);
        } else if (message.kind === "error") {
          this.stop(`NT4 ended. ${message.message}`, true);
        }
      } catch (error) {
        this.stop((error as Error).message, true);
      }
    });
    this.#socket.addEventListener("error", () => this.stop("Could not connect to the NT4 bridge.", true));
    this.#socket.addEventListener("close", () => this.stop("NT4 connection closed.", true));
  }

  private flush(): void {
    if (!this.#connected || this.#closed) return;
    try {
      this.source.drain();
      this.update(this.source.capture.count ? this.source.diagnostic() :
        this.source.diagnostic() || "Waiting for aligned NT4 samples.");
    } catch (error) {
      this.stop((error as Error).message, true);
    }
  }

  stop(message = "", interrupted = false): void {
    if (this.#closed) return;
    this.#closed = true;
    window.clearTimeout(this.#timeout);
    window.clearInterval(this.#refresh);
    this.#socket.close();
    try {
      this.source.drain(true);
    } catch (error) {
      message = [message, (error as Error).message].filter(Boolean).join(" ");
      interrupted = true;
    }
    const excluded = interrupted && this.source.interrupt();
    this.finish([
      message, this.source.diagnostic(), excluded ? "The interrupted test run was excluded." : "",
      this.source.capture.count ? "" : "No aligned NT4 samples captured.",
    ].filter(Boolean).join(" "), interrupted);
  }
}
