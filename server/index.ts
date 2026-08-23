/*
 * Transport WebSocket. Volontairement mince: toute la logique vit dans room.ts,
 * qui se teste sans ouvrir de connexion. Ce fichier traduit des messages en appels
 * et rediffuse l etat, rien de plus.
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "../shared/protocol";
import { createRegistry, type Room } from "./roomRegistry";
import { fetchVideoTitle } from "./videoTitle";
import { createStaticHandler } from "./static";

const PORT = Number(process.env["PORT"] ?? 8787);

const CONFIG = {
  maxParticipants: 2,
  maxWaitMs: 45_000,
  leadMs: 500,
  graceMs: 30_000,
};

/** Cadence de rediffusion des positions: celle de la boucle client (mesure du 19/08). */
const BROADCAST_MS = 1_000;
const SWEEP_MS = 10_000;

interface Session {
  participantId: string;
  code: string | null;
}

const registry = createRegistry(CONFIG);
const sessions = new Map<WebSocket, Session>();

/*
 * Identifiant de participant. Tire de la source cryptographique du systeme comme le
 * code de room: il circule entre les deux clients et sert a s adresser a quelqu un.
 */
function newParticipantId(): string {
  return "p" + randomBytes(6).toString("hex");
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function membersOf(code: string): Array<[WebSocket, Session]> {
  return [...sessions.entries()].filter(([, s]) => s.code === code);
}

function broadcast(code: string, message: ServerMessage): void {
  for (const [socket] of membersOf(code)) send(socket, message);
}

/** L etat porte `youAre`, qui differe par destinataire: on ne peut pas le diffuser tel quel. */
function broadcastState(code: string, room: Room): void {
  const snapshot = room.state();
  for (const [socket, session] of membersOf(code)) {
    send(socket, { type: "room_state", youAre: session.participantId, ...snapshot });
  }
}

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

function fail(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { type: "error", code, message });
}

/*
 * Garde-fous pour un serveur expose publiquement. Aucune donnee sensible ne transite
 * ici, mais une room est de la memoire et une connexion ouverte est une ressource:
 * sans plafond, n importe qui peut en consommer autant qu il veut.
 */
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ROOMS = 500;
const MAX_MESSAGES_PER_10S = 200;
const ALLOWED_ORIGIN = process.env["ALLOWED_ORIGIN"] ?? null;

/*
 * Un seul port sert l application et les connexions temps reel. C est ce qui permet de
 * n exposer qu un tunnel, et c est aussi la forme que prendra le deploiement.
 */
const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const serveStatic = createStaticHandler(distDir);

const http = createServer((request, response) => {
  void serveStatic(request, response);
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: MAX_PAYLOAD_BYTES,
  /*
   * Sans verification d origine, n importe quel site peut ouvrir une connexion vers
   * ce serveur depuis le navigateur d un visiteur et piloter des rooms. Non defini en
   * developpement, ou l origine varie; a renseigner au deploiement.
   */
  verifyClient: ALLOWED_ORIGIN === null
    ? undefined
    : ({ origin }, done) => done(origin === ALLOWED_ORIGIN, 403, "origine refusee"),
});

wss.on("connection", (socket) => {
  sessions.set(socket, { participantId: newParticipantId(), code: null });
  // Budget glissant de messages: une connexion qui inonde est fermee, pas servie.
  let budget = MAX_MESSAGES_PER_10S;
  const refill = setInterval(() => { budget = MAX_MESSAGES_PER_10S; }, 10_000);
  socket.on("close", () => clearInterval(refill));

  socket.on("message", (raw) => {
    const session = sessions.get(socket);
    if (!session) return;

    if (budget-- <= 0) {
      socket.close(1008, "trop de messages");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return fail(socket, "bad_message", "message illisible");
    }

    const parsed = parseClientMessage(payload);
    if (!parsed.ok) return fail(socket, "bad_message", parsed.error);

    const now = Date.now();
    const message = parsed.value;

    // La sonde d horloge repond immediatement et ne passe par aucune room: tout
    // traitement intercale fausserait la mesure qu elle sert a produire.
    if (message.type === "clock_probe") {
      const room = session.code ? registry.get(session.code) : undefined;
      const reply = room
        ? room.clockProbe(message.clientSentAt, now)
        : { clientSentAt: message.clientSentAt, serverReceivedAt: now, serverSentAt: Date.now() };
      return send(socket, { type: "clock_probe_reply", ...reply });
    }

    if (message.type === "create_room") {
      const { code, room } = registry.create(now);
      room.join(session.participantId, now, message.name);
      session.code = code;
      return broadcastState(code, room);
    }

    if (message.type === "join_room") {
      const room = registry.get(message.code);
      if (!room) return fail(socket, "room_not_found", "aucune room ne porte ce code");
      /*
       * Rafraichir la page tue la socket, donc l identite tiree a la connexion. Sans
       * cette reprise le client revient en inconnu, se voit refuser une room dont il
       * occupe encore une place, et la room finit par mourir avec sa file: le defaut
       * remonte a l usage le 23/08/2026. Le delai de grace de la room existait deja,
       * il ne servait a rien tant que personne ne rapportait son identifiant.
       */
      const claimed = message.participantId;
      if (claimed !== undefined && room.reclaimable(claimed, now)) session.participantId = claimed;

      const joined = room.join(session.participantId, now, message.name);
      if (!joined.ok) return fail(socket, joined.code, joined.message);
      session.code = message.code;
      broadcastState(message.code, room);
      /*
       * Rejoindre une room en cours de lecture ouvre un depart commun (F1): sans lui,
       * l arrivant ne sait pas ou se placer et demarre au debut du morceau.
       */
      const rejoin = room.rejoinBarrier(now);
      if (rejoin) {
        broadcast(message.code, {
          type: "waiting", barrierId: rejoin.barrierId, positionMs: rejoin.positionMs,
          waitingFor: rejoin.waitingFor, sinceServerMs: now,
        });
      }
      return;
    }

    const code = session.code;
    const room = code ? registry.get(code) : undefined;
    if (!code || !room) return fail(socket, "not_in_room", "rejoins une room d abord");

    switch (message.type) {
      case "queue_add": {
        const added = room.queueAdd(session.participantId, message.videoId, now);
        if (!added.ok) return fail(socket, added.code, added.message);
        broadcastState(code, room);
        /*
         * Le titre arrive apres coup. Le morceau est ajoute et jouable immediatement:
         * attendre YouTube pour afficher une ligne de file serait une regression.
         */
        const itemId = added.itemId;
        void fetchVideoTitle(message.videoId).then((title: string | null) => {
          if (title === null) return;
          const still = registry.get(code);
          if (still && still.setTitle(itemId, title)) broadcastState(code, still);
        });
        return;
      }
      case "track_ended": {
        const outcome = room.trackEnded(message.itemId, now);
        if (!outcome.advanced) return; // rapport en double: le morceau a deja change
        broadcastState(code, room);
        if (!outcome.hasNext) return;  // file terminee: la lecture s arrete (R7)
        const waiting = room.resumeAt(0, now);
        return broadcast(code, {
          type: "waiting", barrierId: waiting.barrierId, positionMs: waiting.positionMs,
          waitingFor: waiting.waitingFor, sinceServerMs: now,
        });
      }
      case "queue_remove": {
        const removed = room.queueRemove(session.participantId, message.itemId, now);
        if (!removed.ok) return fail(socket, removed.code, removed.message);
        return broadcastState(code, room);
      }
      case "control_transport": {
        room.control(message.action, now);
        broadcastState(code, room);
        // Toute reprise passe par un depart commun (R11), sans exception.
        if (message.action === "play" || message.action === "next" || message.action === "previous") {
          /*
           * Reprendre la ou on s est arrete. Un changement de morceau repart de zero,
           * une simple lecture reprend a la position figee lors de la pause.
           */
          const from = message.action === "play" ? room.positionNow(now) : 0;
          const waiting = room.resumeAt(from, now);
          broadcast(code, { type: "waiting", barrierId: waiting.barrierId, positionMs: waiting.positionMs, waitingFor: waiting.waitingFor, sinceServerMs: now });
        }
        return;
      }
      case "control_seek": {
        const waiting = room.resumeAt(message.positionMs, now);
        broadcastState(code, room);
        return broadcast(code, { type: "waiting", barrierId: waiting.barrierId, positionMs: waiting.positionMs, waitingFor: waiting.waitingFor, sinceServerMs: now });
      }
      case "ready": {
        const outcome = room.ready(session.participantId, message.barrierId, now);
        if (outcome.kind === "start") {
          return broadcast(code, {
            type: "common_start",
            barrierId: outcome.barrierId,
            positionMs: outcome.positionMs,
            startAtServerMs: outcome.startAtServerMs,
          });
        }
        if (outcome.kind === "waiting") {
          return broadcast(code, { type: "waiting", barrierId: outcome.barrierId, positionMs: outcome.positionMs, waitingFor: outcome.waitingFor, sinceServerMs: now });
        }
        return;
      }
      case "retract_ready": {
        const outcome = room.retract(session.participantId, message.barrierId, now);
        if (outcome.kind === "waiting") {
          return broadcast(code, { type: "waiting", barrierId: outcome.barrierId, positionMs: outcome.positionMs, waitingFor: outcome.waitingFor, sinceServerMs: now });
        }
        return;
      }
      case "stall": {
        const outcome = room.stall(session.participantId, message.positionMs, now);
        if (outcome.kind === "waiting") {
          broadcastState(code, room);
          return broadcast(code, { type: "waiting", barrierId: outcome.barrierId, positionMs: outcome.positionMs, waitingFor: outcome.waitingFor, sinceServerMs: now });
        }
        return;
      }
      case "position_report": {
        room.reportPosition(session.participantId, { positionMs: message.positionMs, fresh: message.fresh }, now);
        return;
      }
    }
  });

  socket.on("close", () => {
    const session = sessions.get(socket);
    sessions.delete(socket);
    if (!session?.code) return;
    const room = registry.get(session.code);
    if (!room) return;
    room.disconnect(session.participantId, Date.now());
    broadcastState(session.code, room);
  });
});

setInterval(() => {
  const now = Date.now();
  const codes = new Set([...sessions.values()].map((s) => s.code).filter((c): c is string => c !== null));
  for (const code of codes) {
    const room = registry.get(code);
    if (!room) continue;
    const outcome = room.tick(now);
    if (outcome.kind === "start") {
      broadcast(code, {
        type: "common_start",
        barrierId: outcome.barrierId,
        positionMs: outcome.positionMs,
        startAtServerMs: outcome.startAtServerMs,
      });
    }
    broadcast(code, { type: "peer_positions", ...room.peerPositions(now) });
  }
}, BROADCAST_MS);

setInterval(() => registry.sweep(Date.now()), SWEEP_MS);

http.listen(PORT, () => {
  console.log(`SyncMusic sur http://localhost:${PORT}`);
  if (ALLOWED_ORIGIN === null) {
    console.log("ALLOWED_ORIGIN non defini: toute origine est acceptee (developpement).");
  }
});
