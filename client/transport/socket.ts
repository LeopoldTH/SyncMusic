/*
 * Transport WebSocket cote client. Mince par construction: il valide ce qui entre
 * et transmet ce qui sort. Aucune decision de synchronisation ici (KTD6).
 *
 * La reconnexion vit ici, pas dans App: c est une affaire de transport. Un hoquet
 * wifi ou un ecran de telephone qui se met en veille tue la socket, et le serveur
 * garde la place pendant son delai de grace: rouvrir tout seul est ce qui rend ce
 * delai utile. Ce que l on renvoie une fois reconnecte appartient a l appelant,
 * via onOpen, qui est rappele a chaque reouverture.
 */

import { parseServerMessage, type ClientMessage, type ServerMessage } from "../../shared/protocol";

export interface Transport {
  send(message: ClientMessage): void;
  close(): void;
}

export interface TransportHandlers {
  onMessage(message: ServerMessage): void;
  /** Rappele a chaque (re)ouverture: c est ici que l appelant rejoint sa room. */
  onOpen?(): void;
  onClose?(): void;
  /** Un message que le serveur envoie et que le client ne sait pas lire est un bug, pas du bruit. */
  onProtocolError?(error: string): void;
}

/* Le premier essai est rapide (un hoquet dure une seconde), les suivants s espacent
 * pour ne pas marteler un serveur vraiment tombe. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

export function connect(url: string, handlers: TransportHandlers): Transport {
  let socket: WebSocket;
  let open = false;
  let closedByUs = false;
  let retryDelayMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function attach(): void {
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      open = true;
      retryDelayMs = RETRY_MIN_MS;
      handlers.onOpen?.();
    });

    socket.addEventListener("close", () => {
      open = false;
      handlers.onClose?.();
      if (closedByUs) return;
      retryTimer = setTimeout(attach, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
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
  }

  attach();

  return {
    send(message: ClientMessage): void {
      if (open) socket.send(JSON.stringify(message));
    },
    close(): void {
      closedByUs = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.close();
    },
  };
}
