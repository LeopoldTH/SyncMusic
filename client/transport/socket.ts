/*
 * Transport WebSocket cote client. Mince par construction: il valide ce qui entre
 * et transmet ce qui sort. Aucune decision de synchronisation ici (KTD6).
 */

import { parseServerMessage, type ClientMessage, type ServerMessage } from "../../shared/protocol";

export interface Transport {
  send(message: ClientMessage): void;
  close(): void;
  readonly connected: boolean;
}

export interface TransportHandlers {
  onMessage(message: ServerMessage): void;
  onOpen?(): void;
  onClose?(): void;
  /** Un message que le serveur envoie et que le client ne sait pas lire est un bug, pas du bruit. */
  onProtocolError?(error: string): void;
}

export function connect(url: string, handlers: TransportHandlers): Transport {
  const socket = new WebSocket(url);
  let open = false;

  socket.addEventListener("open", () => {
    open = true;
    handlers.onOpen?.();
  });

  socket.addEventListener("close", () => {
    open = false;
    handlers.onClose?.();
  });

  socket.addEventListener("message", (event) => {
    let payload: unknown;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      handlers.onProtocolError?.("message illisible");
      return;
    }
    const parsed = parseServerMessage(payload);
    if (!parsed.ok) {
      handlers.onProtocolError?.(parsed.error);
      return;
    }
    handlers.onMessage(parsed.value);
  });

  return {
    send(message: ClientMessage): void {
      if (open) socket.send(JSON.stringify(message));
    },
    close(): void {
      socket.close();
    },
    get connected(): boolean {
      return open;
    },
  };
}
