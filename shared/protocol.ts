import { z } from "zod";

/*
 * Definition unique du protocole. Ce fichier est lu par le serveur et par le client:
 * c'est la raison pour laquelle le projet est en TypeScript des deux cotes (KTD4).
 * Un champ renomme ici casse la compilation partout, au lieu de produire un `undefined`
 * silencieux a l'execution.
 *
 * Validation stricte volontaire: tout champ inconnu est rejete. Les deux clients
 * chargent la meme version depuis le meme deploiement (KD9, room ephemere), donc il
 * n'existe aucune compatibilite ascendante a preserver, et une faute de frappe doit
 * echouer bruyamment.
 */

/** Millisecondes. Horloge murale du serveur, ou horloge locale du client selon le champ. */
const Millis = z.number().finite();

const RoomCode = z.string().regex(/^[A-Z]{4}$/, "code de room: quatre lettres majuscules");
const VideoId = z.string().regex(/^[\w-]{11}$/, "identifiant de video YouTube: onze caracteres");

/* --- Client vers serveur --------------------------------------------------- */

/** Pseudo choisi par l utilisateur. Borne pour qu il tienne dans l interface. */
const Pseudo = z.string().trim().min(1, "choisis un pseudo").max(20, "pseudo trop long");

export const CreateRoom = z.object({
  type: z.literal("create_room"),
  name: Pseudo,
}).strict();

export const JoinRoom = z.object({
  type: z.literal("join_room"),
  code: RoomCode,
  name: Pseudo,
}).strict();

export const QueueAdd = z.object({
  type: z.literal("queue_add"),
  videoId: VideoId,
}).strict();

export const QueueRemove = z.object({
  type: z.literal("queue_remove"),
  itemId: z.string().min(1),
}).strict();

/** play / pause / next / previous. Le saut a sa propre forme, pour eviter un champ optionnel. */
export const ControlTransport = z.object({
  type: z.literal("control_transport"),
  action: z.enum(["play", "pause", "next", "previous"]),
}).strict();

export const ControlSeek = z.object({
  type: z.literal("control_seek"),
  positionMs: Millis.nonnegative(),
}).strict();

/** Sonde d'horloge. `clientSentAt` est lu sur l'horloge du client (KTD1). */
export const ClockProbe = z.object({
  type: z.literal("clock_probe"),
  clientSentAt: Millis,
}).strict();

/*
 * Disponibilite pour un depart commun. `barrierId` est obligatoire: sans lui, un
 * "pret" emis pour la barriere precedente peut completer le quorum de la suivante
 * et faire repartir tout le monde sur le morceau d'avant (KTD11).
 */
export const Ready = z.object({
  type: z.literal("ready"),
  barrierId: z.number().int().nonnegative(),
  positionMs: Millis.nonnegative(),
}).strict();

/** Retractation d'une disponibilite deja annoncee: le client a cale avant l'instant de depart. */
export const RetractReady = z.object({
  type: z.literal("retract_ready"),
  barrierId: z.number().int().nonnegative(),
}).strict();

/** Le client n'avance plus alors qu'il devrait lire (KD6, detection par symptome). */
export const Stall = z.object({
  type: z.literal("stall"),
  positionMs: Millis.nonnegative(),
}).strict();

/*
 * Rapport periodique de position. Source unique de l'ecart par paire: un client ne
 * connait que son propre ecart a la timeline, jamais celui de l'autre.
 * `fresh` est faux quand la position lue est une extrapolation locale perimee (KTD5).
 */
export const PositionReport = z.object({
  type: z.literal("position_report"),
  positionMs: Millis.nonnegative(),
  observedAt: Millis,
  fresh: z.boolean(),
}).strict();

/*
 * Fin de piste. Les deux clients l annoncent, le serveur n avance qu une fois: le
 * second rapport porte l identifiant du morceau precedent et se trouve ignore.
 */
export const TrackEnded = z.object({
  type: z.literal("track_ended"),
  itemId: z.string().min(1),
}).strict();

export const ClientMessage = z.discriminatedUnion("type", [
  CreateRoom, JoinRoom, QueueAdd, QueueRemove, ControlTransport, ControlSeek,
  ClockProbe, Ready, RetractReady, Stall, PositionReport, TrackEnded,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/* --- Serveur vers client --------------------------------------------------- */

export const QueueItem = z.object({
  itemId: z.string().min(1),
  videoId: VideoId,
  addedBy: z.string().min(1),
  /*
   * Titre lisible. Null tant que le serveur ne l a pas recupere: un morceau doit
   * pouvoir etre ajoute et joue meme si YouTube ne repond pas.
   */
  title: z.string().nullable(),
}).strict();
export type QueueItem = z.infer<typeof QueueItem>;

export const Participant = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
}).strict();
export type Participant = z.infer<typeof Participant>;

export const RoomState = z.object({
  type: z.literal("room_state"),
  code: RoomCode,
  youAre: z.string().min(1),
  participants: z.array(Participant),
  queue: z.array(QueueItem),
  currentItemId: z.string().min(1).nullable(),
  playing: z.boolean(),
}).strict();

/*
 * Reponse de sonde. Les trois horodatages permettent au client de retirer le temps
 * de traitement serveur avant d'estimer son ecart:
 *   reseau = (recu - envoye) - (serverSentAt - serverReceivedAt)
 *   ecart  = ((serverReceivedAt - clientSentAt) + (serverSentAt - recu)) / 2
 */
export const ClockProbeReply = z.object({
  type: z.literal("clock_probe_reply"),
  clientSentAt: Millis,
  serverReceivedAt: Millis,
  serverSentAt: Millis,
}).strict();

/** Le couple qui fait tout le travail: ou reprendre, et quand (R11). */
export const CommonStart = z.object({
  type: z.literal("common_start"),
  barrierId: z.number().int().nonnegative(),
  positionMs: Millis.nonnegative(),
  startAtServerMs: Millis,
}).strict();

/*
 * L attente porte la position: sans elle, un client mis en attente ne sait pas ou se
 * placer avant de se declarer pret, et le depart commun repartirait de positions
 * differentes. Trou revele a l assemblage, pas a la conception.
 */
export const Waiting = z.object({
  type: z.literal("waiting"),
  barrierId: z.number().int().nonnegative(),
  positionMs: Millis.nonnegative(),
  waitingFor: z.array(z.string().min(1)),
  sinceServerMs: Millis,
}).strict();

/*
 * Positions de chacun, toutes ramenees au meme instant `atServerMs`.
 *
 * Le recalage est indispensable: chaque client rapporte a son rythme, et soustraire
 * deux positions relevees a une seconde d intervalle fabrique une seconde d ecart qui
 * n existe pas. Le serveur est le seul endroit ou une horloge commune existe.
 */
export const PeerPositions = z.object({
  type: z.literal("peer_positions"),
  atServerMs: Millis,
  positions: z.array(z.object({
    participantId: z.string().min(1),
    positionMs: Millis.nonnegative(),
    /** Faux quand la position rapportee etait deja une extrapolation locale perimee. */
    fresh: z.boolean(),
    /** Age du rapport d origine, en ms. Au-dela de quelques centaines, se mefier. */
    ageMs: Millis.nonnegative(),
  }).strict()),
}).strict();

export const ProtocolError = z.object({
  type: z.literal("error"),
  code: z.enum(["room_not_found", "room_full", "not_in_room", "bad_message", "cannot_remove_playing"]),
  message: z.string().min(1),
}).strict();

export const ServerMessage = z.discriminatedUnion("type", [
  RoomState, ClockProbeReply, CommonStart, Waiting, PeerPositions, ProtocolError,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/* --- Analyse --------------------------------------------------------------- */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Nomme le champ fautif dans le message d'erreur. C'est ce qui rend une faute de frappe
 * lisible en une seconde plutot qu'apres une heure de debogage.
 */
function describe(issues: z.ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "message invalide";
  const path = first.path.join(".");
  const where = path.length > 0 ? path : "(racine)";
  return `${where}: ${first.message}`;
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const result = schema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: describe(result.error.issues) };
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return parseWith(ClientMessage, raw);
}

export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return parseWith(ServerMessage, raw);
}

/**
 * Verifie la coherence interne d'une reponse de sonde.
 *
 * Seuls `serverReceivedAt` et `serverSentAt` sont comparables entre eux: ils viennent
 * de la meme horloge. Comparer `clientSentAt` a l'un des deux n'a aucun sens, puisque
 * l'ecart entre les deux horloges est precisement l'inconnue que la sonde cherche.
 * C'est le piege classique de ce protocole.
 */
export function probeReplyIsCoherent(reply: z.infer<typeof ClockProbeReply>): boolean {
  return reply.serverReceivedAt <= reply.serverSentAt;
}
