import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant, QueueItem, ServerMessage } from "../shared/protocol";
import { connect, type Transport } from "./transport/socket";
import { loadYouTubeApi } from "./player/loadYouTubeApi";
import { createYouTubePlayer, faultFromErrorCode } from "./player/youtubePlayer";
import { createClockEstimator } from "./sync/clock";
import { createDriftLog } from "./sync/driftLog";
import { createSession } from "./sync/session";
import { LOOP_MS, SYNC_THRESHOLDS } from "./sync/thresholds";
import { parseVideoId } from "./lib/videoId";
import { resolveServerUrl } from "./lib/serverUrl";
import { RoomJoin } from "./components/RoomJoin";
import { Queue } from "./components/Queue";
import { Transport as TransportBar } from "./components/Transport";
import { SyncBadge } from "./components/SyncBadge";
import { RoomCode } from "./components/RoomCode";
import { PlayerFrame } from "./components/PlayerFrame";
import { DriftChart } from "./components/DriftChart";
import { LatencyCalibration } from "./components/LatencyCalibration";
import type { DriftPoint } from "./sync/driftLog";

interface RoomView {
  code: string;
  youAre: string;
  participants: Participant[];
  queue: QueueItem[];
  currentItemId: string | null;
  playing: boolean;
}

export function App() {
  const transport = useRef<Transport | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [waitingFor, setWaitingFor] = useState<string[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [pairGap, setPairGap] = useState<number | null>(null);
  const [drift, setDrift] = useState<readonly DriftPoint[]>([]);
  const [pseudo, setPseudo] = useState(() => window.localStorage.getItem("syncmusic.pseudo") ?? "");
  const [latencyMs, setLatencyMs] = useState(() => {
    const stored = window.localStorage.getItem("syncmusic.latencyMs");
    return stored === null ? 0 : Number(stored);
  });
  const session = useRef<ReturnType<typeof createSession> | null>(null);
  /*
   * Les messages arrives avant que le lecteur soit pret seraient perdus: le depart
   * commun ouvre sa barriere des le clic sur Lecture, alors que la session ne naît
   * qu apres onReady. On les garde et on les rejoue.
   */
  const early = useRef<Array<{ message: ServerMessage; atMs: number }>>([]);
  const port = useRef<ReturnType<typeof createYouTubePlayer> | null>(null);
  const playerCreated = useRef(false);
  const [playerReady, setPlayerReady] = useState(false);
  /* Tout clic dans l application vaut geste utilisateur pour les conditions d utilisation. */
  const gestured = useRef(false);
  const loadedVideo = useRef<string | null>(null);

  const handle = useCallback((message: ServerMessage) => {
    const atMs = Date.now();
    if (session.current) session.current.onServerMessage(message, atMs);
    else early.current.push({ message, atMs });
    switch (message.type) {
      case "room_state":
        setRoom({
          code: message.code,
          youAre: message.youAre,
          participants: message.participants,
          queue: message.queue,
          currentItemId: message.currentItemId,
          playing: message.playing,
        });
        setError(null);
        return;
      case "waiting":
        setWaitingFor(message.waitingFor);
        setWaitingSince((previous) => previous ?? Date.now());
        return;
      case "common_start":
        setWaitingFor([]);
        setWaitingSince(null);
        return;
      case "error":
        setError(message.message);
        return;
      default:
        return;
    }
  }, []);

  useEffect(() => {
    const url = resolveServerUrl(import.meta.env as Record<string, string | undefined>, window.location);
    const socket = connect(url, {
      onMessage: handle,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onProtocolError: (reason) => setError(`Message du serveur illisible: ${reason}`),
    });
    transport.current = socket;
    return () => socket.close();
  }, [handle]);

  /*
   * Une erreur s efface toute seule. Un bandeau qui reste affiche apres coup devient
   * du decor: on finit par ne plus le lire, y compris quand il dit quelque chose.
   */
  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);

  // Une horloge d affichage: la barre d etat montre une duree qui doit avancer.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const currentVideoId =
    room?.queue.find((q) => q.itemId === room.currentItemId)?.videoId ?? null;

  /*
   * Creation du lecteur, une seule fois, des qu un morceau courant existe.
   * Un lecteur cree sans identifiant de video n emet jamais onReady: il n a rien a
   * preparer, et le cadre reste noir sans la moindre erreur.
   */
  useEffect(() => {
    if (currentVideoId === null || playerCreated.current) return;
    playerCreated.current = true;
    let cancelled = false;

    void loadYouTubeApi().then((Player) => {
      if (cancelled) return;
      const raw = new Player("yt-player", {
        videoId: currentVideoId,
        playerVars: { rel: 0, playsinline: 1 },
        events: {
          /*
           * Le lecteur n est utilisable qu apres onReady. Avant, loadVideoById et
           * playVideo ne font rien et ne le disent pas: le cadre reste noir sans la
           * moindre erreur. C est pour cela que la session ne naît qu ici.
           */
          onReady: () => {
            const port_ = createYouTubePlayer({
              raw,
              // Fraction visible du lecteur: la lecture automatique n est permise au
              // premier demarrage que si plus de la moitie du cadre est a l ecran.
              visibleFraction: () => {
                const el = document.getElementById("yt-player");
                if (!el || document.hidden) return 0;
                const box = el.getBoundingClientRect();
                const shown = Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0));
                return box.height === 0 ? 0 : shown / box.height;
              },
              hasUserGesture: () => gestured.current,
            });
            port.current = port_;
            session.current = createSession({
              player: port_,
              clock: createClockEstimator(),
              log: createDriftLog(),
              thresholds: SYNC_THRESHOLDS,
              send: (message) => transport.current?.send(message),
            });
            loadedVideo.current = currentVideoId;
            for (const pending of early.current) {
              session.current.onServerMessage(pending.message, pending.atMs);
            }
            early.current = [];
            if (import.meta.env.DEV) {
              (window as unknown as { sm?: unknown }).sm = session.current;
            }
            setPlayerReady(true);
          },
          onError: (event) => {
            const fault = faultFromErrorCode(event.data);
            setError(
              fault.kind === "referer_missing"
                ? "Le lecteur YouTube refuse de demarrer: en-tete Referer absent (erreur 153)."
                : `Le lecteur YouTube a renvoye l erreur ${event.data}.`
            );
          },
        },
      });
    });

    return () => { cancelled = true; };
  }, [currentVideoId]);

  /*
   * Chargement du morceau courant. Le lecteur remet la vitesse a 1 au chargement:
   * l adaptateur le signale, et la session annule sa correction en cours.
   */
  useEffect(() => {
    if (currentVideoId === null || currentVideoId === loadedVideo.current || !port.current) return;
    loadedVideo.current = currentVideoId;
    port.current.load(currentVideoId, Date.now());
  }, [currentVideoId, playerReady]);

  // La boucle de synchronisation. Sa cadence vient de la mesure du 2026-08-19:
  // en onglet arriere-plan les minuteries tombent a une par seconde de toute facon.
  useEffect(() => {
    const timer = setInterval(() => {
      const current = session.current;
      if (!current) return;
      current.tick(Date.now());
      setPairGap(current.pairGapMs());
      setDrift([...current.driftPoints()]);
    }, LOOP_MS);
    return () => clearInterval(timer);
  }, []);

  // Le reglage vit sur l appareil: la latence d une enceinte ne concerne que son
  // proprietaire, et la redemander a chaque session serait absurde.
  useEffect(() => {
    window.localStorage.setItem("syncmusic.latencyMs", String(latencyMs));
    session.current?.setOutputLatencyMs(latencyMs);
  }, [latencyMs, playerReady]);

  const rawSend = transport.current?.send.bind(transport.current);
  const send = rawSend
    ? (message: Parameters<NonNullable<typeof rawSend>>[0]) => {
        gestured.current = true;
        rawSend(message);
      }
    : undefined;

  if (room === null) {
    const remember = (name: string) => {
      window.localStorage.setItem("syncmusic.pseudo", name);
      setPseudo(name);
    };
    return (
      <RoomJoin
        initialName={pseudo}
        onCreate={(name) => { remember(name); send?.({ type: "create_room", name }); }}
        onJoin={(code, name) => { remember(name); send?.({ type: "join_room", code, name }); }}
        error={error}
      />
    );
  }

  function addFromLink(): void {
    const parsed = parseVideoId(link);
    if (!parsed.ok) return setError(parsed.reason);
    send?.({ type: "queue_add", videoId: parsed.videoId });
    setLink("");
    setError(null);
  }

  const current = room.queue.find((q) => q.itemId === room.currentItemId) ?? null;
  /* Un identifiant technique ne doit jamais atteindre l ecran. */
  const nameOf = (id: string): string =>
    id === room.youAre ? "toi" : room.participants.find((p) => p.id === id)?.name ?? "ton pote";
  const others = room.participants.filter((p) => p.id !== room.youAre);

  return (
    <div className="shell">
      <header className="top">
        <span className="top__brand">SyncMusic</span>
        <RoomCode code={room.code} />
        <span className="peers">
          {others.length === 0 ? "toi seul" : `avec ${others.map((p) => p.name).join(", ")}`}
        </span>
      </header>

      <SyncBadge
        connected={connected}
        waitingFor={waitingFor.map(nameOf)}
        waitingSinceMs={waitingSince}
        nowMs={now}
        pairGapMs={pairGap}
        hasPeer={others.length > 0}
        playing={room.playing}
        thresholdMs={SYNC_THRESHOLDS.floorMs * 2}
      />

      <section className="stage">
        <PlayerFrame />
        <div className="now">
          {current === null ? (
            <h1 className="now__title now__title--idle">Rien en lecture</h1>
          ) : (
            <>
              <h1 className="now__title">{current.title ?? current.videoId}</h1>
              <p className="now__by">ajoute par {nameOf(current.addedBy)}</p>
            </>
          )}
        </div>
        <TransportBar
          playing={room.playing}
          disabled={room.queue.length === 0}
          onPlay={() => send?.({ type: "control_transport", action: "play" })}
          onPause={() => send?.({ type: "control_transport", action: "pause" })}
          onNext={() => send?.({ type: "control_transport", action: "next" })}
          onPrevious={() => send?.({ type: "control_transport", action: "previous" })}
        />
      </section>

      <section className="queue-panel">
        <div className="queue-panel__head">
          <h2>La file</h2>
          <span className="queue-panel__count">
            {room.queue.length === 0 ? "vide" : `${room.queue.length} morceau${room.queue.length > 1 ? "x" : ""}`}
          </span>
        </div>

        <form
          className="add"
          onSubmit={(e) => {
            e.preventDefault();
            addFromLink();
          }}
        >
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Colle un lien YouTube"
            aria-label="Lien YouTube"
          />
          <button type="submit" className="btn">Ajouter</button>
        </form>

        {error === null ? null : <p className="error">{error}</p>}

        <Queue
          items={room.queue}
          currentItemId={room.currentItemId}
          nameOf={nameOf}
          onRemove={(itemId) => send?.({ type: "queue_remove", itemId })}
        />
      </section>

      <details className="diag">
        <summary>Reglages et mesures</summary>
        <div className="diag__body">
          <LatencyCalibration valueMs={latencyMs} onChange={setLatencyMs} />
          <DriftChart points={drift} thresholdMs={SYNC_THRESHOLDS.floorMs * 2} />
        </div>
      </details>
    </div>
  );
}
