/*
 * Transport WebSocket. Volontairement mince: toute la logique vit dans room.ts,
 * qui se teste sans ouvrir de connexion. Ce fichier traduit des messages en appels
 * et rediffuse l etat, rien de plus.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { parseClientMessage, PSEUDO_MAX_CHARS, VideoId, type ServerMessage } from "../shared/protocol";
import { createRegistry, type Room } from "./roomRegistry";
import { fetchVideoTitle } from "./videoTitle";
import { createStaticHandler } from "./static";
import { searchVideos } from "./youtubeSearch";
import { createSearchBudget } from "./searchBudget";
import { LIMITS, openDatabase, resolveDbPath, type HistoryCursor, type User } from "./db";
import { createAuth, readAuthConfig, readBody, sameOrigin, sendJson } from "./auth";
import { recordCommonStart } from "./history";

const PORT = Number(process.env["PORT"] ?? 8787);

const CONFIG = {
  maxParticipants: 2,
  maxWaitMs: 45_000,
  leadMs: 500,
  graceMs: 30_000,
  /** Plafond de la file (KTD9): une playlist envoyee ne peut pas le depasser. */
  maxQueue: 100,
};

/** Cadence de rediffusion des positions: celle de la boucle client (mesure du 19/08). */
const BROADCAST_MS = 1_000;
const SWEEP_MS = 10_000;

interface Session {
  participantId: string;
  code: string | null;
  /*
   * Le compte, fige a l ouverture de la socket (KTD5). Une deconnexion ou un
   * changement de nom en cours de route ne s appliquent qu a la prochaine connexion:
   * l identite d un socket se decide une fois, a l upgrade, jamais en cours de route.
   */
  user: User | null;
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

/*
 * Connecte, le nom du compte fait autorite (KD5): le pseudo envoye par le client est
 * ignore, et le meme nom vaut dans toutes les rooms. Invite, rien ne change. La coupe
 * est une ceinture: le nom est deja borne a l enregistrement.
 */
function nameFor(session: Session, proposed: string): string {
  return session.user ? session.user.name.slice(0, PSEUDO_MAX_CHARS) : proposed;
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

/** Chemin de la socket temps reel. Tout autre upgrade est ferme sans ceremonie. */
const WS_PATH = "/ws";

/*
 * Un seul port sert l application et les connexions temps reel. C est ce qui permet de
 * n exposer qu un tunnel, et c est aussi la forme que prendra le deploiement.
 */
const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const serveStatic = createStaticHandler(distDir);

/*
 * Base ouverte au demarrage, migrations comprises (KTD3). Un schema en retard doit
 * faire echouer le lancement, pas une requete au hasard une heure plus tard. Les
 * rooms n en dependent pas: sans compte, l application marche exactement pareil (R3).
 */
const db = openDatabase(resolveDbPath(process.env["DB_PATH"], distDir));
// Les sessions expirees ne servent plus a rien et s accumuleraient sans fin.
db.deleteExpiredSessions(Date.now());

/*
 * BASE_URL est obligatoire (KTD5). Plutot que la trace d une exception, on rend le
 * message d erreur du module: c est la premiere chose que voit quelqu un qui lance le
 * serveur pour la premiere fois.
 */
const authConfig = (() => {
  try {
    return readAuthConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();

const auth = createAuth({ config: authConfig, db });

/*
 * Les routes de connexion passent avant le service des fichiers: sinon `/auth/login`
 * repondrait la page d accueil. Tout ce qu elles ne reconnaissent pas retombe sur les
 * fichiers construits, comportement inchange.
 */
const http = createServer((request, response) => {
  void (async () => {
    try {
      if (await handleApi(request, response)) return;
      if (await auth.handle(request, response)) return;
      await serveStatic(request, response);
    } catch (error) {
      // Jamais l objet d erreur complet: son contexte peut porter un code OAuth.
      console.error(`erreur sur ${request.method} ${request.url?.split("?")[0]}`);
      void error;
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("erreur serveur");
    }
  })();
});

/*
 * `noServer`: c est nous qui traitons l upgrade, pas `ws`. La doc de `ws` deconseille
 * `verifyClient`, et surtout le controle d origine et la lecture du cookie doivent se
 * faire au meme endroit, avant qu une socket existe.
 */
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

http.on("upgrade", (request, socket, head) => {
  if (new URL(request.url ?? "/", authConfig.origin).pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  const verdict = auth.checkUpgrade(request);
  if (!verdict.ok) {
    socket.write(`HTTP/1.1 ${verdict.status} ${verdict.reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => attachSocket(ws, verdict.user));
});

/*
 * Recherche. Sans cle, la route repond qu elle n est pas configuree et le reste de
 * l application ne change pas: comme pour les identifiants Google, une capacite
 * absente est un mode de fonctionnement, pas une panne (R3).
 */
const YOUTUBE_API_KEY = process.env["YOUTUBE_API_KEY"] ?? null;
const SEARCH_RESULTS = 10;
/** Longueur utile d une requete. Au-dela, c est un collage, pas une recherche. */
const SEARCH_QUERY_MAX_CHARS = 100;

/*
 * Le plafond du jour reste sous les 100 recherches quotidiennes de l API: on veut
 * s arreter nous-memes, avec une phrase lisible, plutot que de decouvrir le mur sur
 * un 403 de Google.
 *
 * Le plafond par client vise le script, pas le curieux. Construire une file pour une
 * soiree demande facilement quinze ou vingt recherches d affilee, et buter dessus a ce
 * moment-la est une frustration pure: la vraie protection vient du plafond quotidien,
 * que celui-ci ne fait que repartir. D ou une valeur large.
 */
const searchBudget = createSearchBudget({
  dailyBudget: 90,
  perClientWindowMs: 10 * 60_000,
  perClientMax: 40,
});

/*
 * Adresse du demandeur, telle que Fly la rapporte. Derriere le proxy, l en-tete est
 * pose par Fly et fait autorite; en local il est absent et la socket suffit. Ce n est
 * pas une identite: juste de quoi eviter qu un seul visiteur vide la journee.
 */
function clientKeyOf(request: IncomingMessage): string {
  const forwarded = request.headers["fly-client-ip"] ?? request.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first ?? "").split(",")[0]?.trim() || request.socket.remoteAddress || "inconnu";
}

/** Taille de page de l historique: assez pour un ecran, bornee pour la reponse. */
const HISTORY_PAGE = 50;

/** Curseur `avant` de la pagination: `playedAt.id` de la derniere entree affichee. */
function parseHistoryCursor(raw: string | null): HistoryCursor | undefined {
  if (raw === null) return undefined;
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(raw);
  if (!match) return undefined;
  return { playedAt: Number(match[1]), id: Number(match[2]) };
}

const PlaylistBody = z.object({
  name: z.string().trim().min(1, "choisis un nom de playlist")
    .max(LIMITS.playlistNameChars, "nom de playlist trop long"),
}).strict();

const PlaylistItemBody = z.object({
  videoId: VideoId,
  /** Present quand l ajout vient de l historique, qui connait deja le titre. */
  title: z.string().max(LIMITS.titleChars).nullable().default(null),
}).strict();

/** Corps JSON borne et valide (KTD9). Repond lui-meme au refus, et rend alors null. */
async function readJson<T>(
  request: IncomingMessage, response: ServerResponse, schema: z.ZodType<T>,
): Promise<T | null> {
  const body = await readBody(request, MAX_PAYLOAD_BYTES);
  if (body === null) {
    sendJson(response, 413, { error: "corps trop volumineux" });
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(response, 400, { error: "corps illisible" });
    return null;
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  sendJson(response, 400, { error: parsed.error.issues[0]?.message ?? "corps invalide" });
  return null;
}

/*
 * Historique et playlists passent par HTTP, pas par le WebSocket (KTD8): ils sont lies
 * au compte, via le cookie, pas a une room. Les routes vivent ici et non dans auth.ts,
 * qui ne connait que la connexion; elles passent avant lui parce que son routeur
 * repond 404 a tout /api/* qu il ne reconnait pas.
 */
async function handleApi(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", authConfig.origin);
  const path = url.pathname;
  const method = request.method ?? "GET";
  /* Les identifiants de playlist sont sequentiels, donc enumerables: chaque route
     scope sa requete par (id, compte) et repond 404 pour la playlist d un autre. */
  /*
   * La recherche passe avant le controle de session: elle sert a remplir la file
   * d une room, pas a consulter un compte, et l application entiere doit rester
   * utilisable en invite (R3). Ce qui la protege n est donc pas le cookie mais le
   * garde de budget, seul rempart devant un quota de cent recherches par jour.
   */
  if (path === "/api/search" && method === "GET") {
    if (YOUTUBE_API_KEY === null) {
      sendJson(response, 503, { error: "la recherche n est pas configuree sur ce serveur" });
      return true;
    }
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, SEARCH_QUERY_MAX_CHARS);
    // Une recherche vide ne coute rien a refuser, et couterait une unite a poser.
    if (query.length === 0) {
      sendJson(response, 200, { results: [] });
      return true;
    }
    const allowed = searchBudget.take(clientKeyOf(request), Date.now());
    if (!allowed.ok) {
      sendJson(response, 429, {
        error: allowed.reason === "daily"
          ? "la recherche a atteint son quota du jour, elle repart demain"
          : "trop de recherches d affilee, laisse passer quelques minutes",
      });
      return true;
    }
    const outcome = await searchVideos(query, YOUTUBE_API_KEY, { maxResults: SEARCH_RESULTS });
    if (!outcome.ok) {
      sendJson(response, outcome.reason === "quota" ? 429 : 502, {
        error: outcome.reason === "quota"
          ? "la recherche a atteint son quota du jour, elle repart demain"
          : "la recherche YouTube n a pas repondu, reessaie",
      });
      return true;
    }
    sendJson(response, 200, { results: outcome.results });
    return true;
  }

  const itemsPath = /^\/api\/playlists\/(\d{1,9})\/items$/.exec(path);
  if (path !== "/api/history" && path !== "/api/playlists" && itemsPath === null) return false;

  // Meme regle que le routeur d auth: un POST venu d un autre site ne declenche rien.
  if (method === "POST" && !sameOrigin(request, authConfig)) {
    sendJson(response, 403, { error: "origine refusee" });
    return true;
  }
  const session = auth.sessionFromCookies(request.headers.cookie);
  if (session === null) {
    sendJson(response, 401, { error: "connexion requise" });
    return true;
  }
  const user = session.user;

  if (path === "/api/history" && method === "GET") {
    /*
     * Pagination par curseur plutot que par offset: l historique grandit par le haut,
     * et un offset glisserait d une page a l autre a chaque nouvelle ecoute.
     */
    const entries = db.listHistory(
      user.id, HISTORY_PAGE, parseHistoryCursor(url.searchParams.get("before")),
    );
    const last = entries[entries.length - 1];
    sendJson(response, 200, {
      entries: entries.map((e) => ({ videoId: e.videoId, title: e.title, playedAt: e.playedAt })),
      nextBefore: entries.length === HISTORY_PAGE && last ? `${last.playedAt}.${last.id}` : null,
    });
    return true;
  }

  if (path === "/api/playlists" && method === "GET") {
    sendJson(response, 200, { playlists: db.listPlaylists(user.id) });
    return true;
  }

  if (path === "/api/playlists" && method === "POST") {
    const body = await readJson(request, response, PlaylistBody);
    if (body === null) return true;
    const created = db.createPlaylist(user.id, body.name, Date.now());
    if (!created.ok) {
      sendJson(response, 400, { error: created.message });
      return true;
    }
    sendJson(response, 200, { id: created.id, name: body.name });
    return true;
  }

  if (itemsPath !== null && method === "GET") {
    const items = db.getPlaylistItems(Number(itemsPath[1]), user.id);
    if (items === null) {
      sendJson(response, 404, { error: "aucune playlist de ce compte ne porte cet identifiant" });
      return true;
    }
    sendJson(response, 200, { items });
    return true;
  }

  if (itemsPath !== null && method === "POST") {
    const body = await readJson(request, response, PlaylistItemBody);
    if (body === null) return true;
    const added = db.addPlaylistItem(
      Number(itemsPath[1]), user.id, { videoId: body.videoId, title: body.title ?? null }, Date.now(),
    );
    if (!added.ok) {
      sendJson(response, added.code === "playlist_not_found" ? 404 : 400, { error: added.message });
      return true;
    }
    sendJson(response, 200, { position: added.position });
    return true;
  }

  sendJson(response, 404, { error: "route inconnue" });
  return true;
}

/*
 * Un depart commun se diffuse et s inscrit a l historique au meme endroit (U5, KTD6):
 * c est le seul instant ou le serveur sait a la fois quel morceau part et qui est la
 * pour l entendre. Le handler `ready` et la boucle de tick passent tous deux par ici.
 */
function broadcastStart(
  code: string,
  room: Room,
  outcome: { barrierId: number; positionMs: number; startAtServerMs: number },
  nowMs: number,
): void {
  broadcast(code, {
    type: "common_start",
    barrierId: outcome.barrierId,
    positionMs: outcome.positionMs,
    startAtServerMs: outcome.startAtServerMs,
  });
  const instanceId = registry.instanceOf(code);
  if (instanceId === undefined) return;
  recordCommonStart({
    db,
    instanceId,
    snapshot: room.state(),
    users: membersOf(code).map(([, s]) => s.user),
    nowMs,
  });
}

function attachSocket(socket: WebSocket, user: User | null): void {
  sessions.set(socket, { participantId: newParticipantId(), code: null, user });
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
      /*
       * Le plafond se verifie avant d allouer quoi que ce soit. Le sweep ne detruit
       * que les rooms que plus personne ne peut rejoindre: sans cette porte, creer
       * des rooms en boucle suffit a faire gonfler la memoire jusqu a la panne.
       */
      if (registry.size() >= MAX_ROOMS) {
        return fail(socket, "server_full", "le serveur est plein, reessaie dans un moment");
      }
      const { code, room } = registry.create(now);
      room.join(session.participantId, now, nameFor(session, message.name));
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

      const joined = room.join(session.participantId, now, nameFor(session, message.name));
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
      case "leave_room": {
        /*
         * Couper la session de la room avant de diffuser: `membersOf` filtre sur
         * `session.code`, donc le partant ne recoit pas l etat qu il vient de quitter.
         * Le recevoir lui ferait reecrire sa trace de reprise et le ramenerait dans la
         * room a la prochaine reouverture de socket.
         */
        session.code = null;
        const outcome = room.leave(session.participantId, now);
        broadcastState(code, room);
        if (outcome.kind === "start") broadcastStart(code, room, outcome, now);
        else if (outcome.kind === "waiting") {
          broadcast(code, {
            type: "waiting", barrierId: outcome.barrierId, positionMs: outcome.positionMs,
            waitingFor: outcome.waitingFor, sinceServerMs: now,
          });
        }
        return;
      }
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
      case "send_playlist": {
        /*
         * L identite du socket decide (KTD5): un invite n a pas de playlist, et un
         * identifiant devine ne donne acces qu aux playlists de son propre compte.
         * La meme reponse couvre les deux cas: pas d oracle sur celles des autres.
         */
        const items = session.user === null
          ? null
          : db.getPlaylistItems(message.playlistId, session.user.id);
        if (items === null) {
          return fail(socket, "playlist_not_found", "aucune playlist de ton compte ne porte cet identifiant");
        }
        if (items.length === 0) return; // rien a envoyer: la file ne change pas
        const sent = room.queueAddAll(
          session.participantId,
          items.map((i) => ({ videoId: i.videoId, title: i.title })),
          now,
        );
        if (!sent.ok) return fail(socket, sent.code, sent.message);
        // Comportement d ajouts ordinaires (R9): la file grandit, rien ne demarre.
        return broadcastState(code, room);
      }
      case "control_transport": {
        room.control(message.action, now);
        broadcastState(code, room);
        // Toute reprise passe par un depart commun (R11), sans exception.
        if (message.action === "play" || message.action === "next" || message.action === "previous") {
          /*
           * Sans morceau courant (un "suivant" en fin de file, une file vide), il n y a
           * rien a faire partir: ouvrir une barriere relancerait la derniere video
           * encore chargee dans les lecteurs, pendant que l ecran dit "rien en lecture".
           */
          if (room.state().currentItemId === null) return;
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
      case "ready": {
        const outcome = room.ready(session.participantId, message.barrierId, now);
        if (outcome.kind === "start") {
          return broadcastStart(code, room, outcome, now);
        }
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
}

setInterval(() => {
  const now = Date.now();
  const codes = new Set([...sessions.values()].map((s) => s.code).filter((c): c is string => c !== null));
  for (const code of codes) {
    const room = registry.get(code);
    if (!room) continue;
    const outcome = room.tick(now);
    if (outcome.kind === "start") broadcastStart(code, room, outcome, now);
    broadcast(code, { type: "peer_positions", ...room.peerPositions(now) });
  }
}, BROADCAST_MS);

setInterval(() => {
  const now = Date.now();
  registry.sweep(now);
  searchBudget.sweep(now);
}, SWEEP_MS);

http.listen(PORT, () => {
  console.log(`SyncMusic sur http://localhost:${PORT}`);
  console.log(`Origine attendue: ${authConfig.origin} (BASE_URL)`);
  if (authConfig.clientId === null) {
    console.log("Sans identifiants Google: application 100% invite, connexion desactivee.");
  }
  if (YOUTUBE_API_KEY === null) {
    console.log("Sans YOUTUBE_API_KEY: recherche desactivee, le collage de lien marche pareil.");
  }
});
