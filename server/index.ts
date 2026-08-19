/*
 * Transport WebSocket. Volontairement mince: toute la logique vit dans room.ts,
 * qui se teste sans ouvrir de connexion. Ce fichier traduit des messages en appels
 * et rediffuse l etat, rien de plus.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "../shared/protocol";
import { createRegistry, type Room } from "./roomRegistry";

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

function newParticipantId(): string {
  return "p" + Math.random().toString(36).slice(2, 10);
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

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket) => {
  sessions.set(socket, { participantId: newParticipantId(), code: null });

  socket.on("message", (raw) => {
    const session = sessions.get(socket);
    if (!session) return;

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
      room.join(session.participantId, now);
      session.code = code;
      return broadcastState(code, room);
    }

    if (message.type === "join_room") {
      const room = registry.get(message.code);
      if (!room) return fail(socket, "room_not_found", "aucune room ne porte ce code");
      const joined = room.join(session.participantId, now);
      if (!joined.ok) return fail(socket, joined.code, joined.message);
      session.code = message.code;
      return broadcastState(message.code, room);
    }

    const code = session.code;
    const room = code ? registry.get(code) : undefined;
    if (!code || !room) return fail(socket, "not_in_room", "rejoins une room d abord");

    switch (message.type) {
      case "queue_add": {
        const added = room.queueAdd(session.participantId, message.videoId, now);
        if (!added.ok) return fail(socket, added.code, added.message);
        return broadcastState(code, room);
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
          const waiting = room.resumeAt(0, now);
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

console.log(`SyncMusic: serveur de rooms sur le port ${PORT}`);
