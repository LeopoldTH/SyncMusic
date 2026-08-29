import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { Participant, QueueItem, ServerMessage } from "../shared/protocol";
import { connect, type Transport } from "./transport/socket";
import { loadYouTubeApi, type YTPlayerCtor } from "./player/loadYouTubeApi";
import { createYouTubePlayer, faultFromErrorCode } from "./player/youtubePlayer";
import { createClockEstimator } from "./sync/clock";
import { createDriftLog } from "./sync/driftLog";
import { createSession } from "./sync/session";
import { LOOP_MS, SYNC_THRESHOLDS } from "./sync/thresholds";
import { parseVideoId } from "./lib/videoId";
import { resolveServerUrl } from "./lib/serverUrl";
import { readResume, saveResume, clearResume, type ResumeRecord } from "./lib/resume";
import { RoomJoin } from "./components/RoomJoin";
import { AccountScreen } from "./components/AccountScreen";
import { History } from "./components/History";
import { Playlists, SendPlaylist } from "./components/Playlists";
import { fetchAccount, logout, saveAccountName, type Account } from "./lib/account";
import { fetchHistory, type HistoryPage } from "./lib/history";
import {
  addPlaylistItem, createPlaylist, fetchPlaylistItems, fetchPlaylists,
  type Playlist, type PlaylistItem,
} from "./lib/playlists";
import { Queue } from "./components/Queue";
import { Transport as TransportBar } from "./components/Transport";
import { SyncBadge } from "./components/SyncBadge";
import { RoomCode } from "./components/RoomCode";
import { LeaveButton } from "./components/LeaveButton";
import { Search } from "./components/Search";
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
  /*
   * `undefined` tant que /api/me n a pas repondu. Distinguer « pas encore su » de
   * « invite » evite de faire clignoter le bouton de connexion au chargement.
   */
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  /** Page d historique chargee, null tant que /api/history n a pas repondu. */
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<number | null>(null);
  const [playlistItems, setPlaylistItems] = useState<PlaylistItem[] | null>(null);
  const path = useLocation().pathname;
  const [latencyMs, setLatencyMs] = useState(() => {
    const stored = window.localStorage.getItem("syncmusic.latencyMs");
    return stored === null ? 0 : Number(stored);
  });
  /*
   * La face de la machine (charte Console): jour par defaut, nuit au choix.
   * Par appareil, comme la latence: le theme est une affaire d ecran, pas de compte.
   */
  const [theme, setTheme] = useState<"jour" | "nuit">(() =>
    window.localStorage.getItem("syncmusic.theme") === "nuit" ? "nuit" : "jour"
  );
  /*
   * Reprise apres rafraichissement. Le ref porte la trace tant que la demande est en
   * vol, et vaut donc aussi de drapeau: non-null signifie "on est en train de revenir",
   * ce que `handle` doit savoir sans dependre d un etat qu il ne relit pas.
   */
  const pendingResume = useRef<ResumeRecord | null>(readResume(window.sessionStorage));
  const [resuming, setResuming] = useState(() => pendingResume.current !== null);
  const session = useRef<ReturnType<typeof createSession> | null>(null);
  /*
   * Les messages arrives avant que le lecteur soit pret seraient perdus: le depart
   * commun ouvre sa barriere des le clic sur Lecture, alors que la session ne naît
   * qu apres onReady. On les garde et on les rejoue.
   */
  const early = useRef<Array<{ message: ServerMessage; atMs: number }>>([]);
  /*
   * De quoi reconstituer une session neuve. Le lecteur peut mourir et renaitre — un
   * aller-retour par l ecran de compte suffit — et la session nait avec lui, vierge.
   * Sans ce rappel elle ignore qui elle est et quelle timeline suivre jusqu au
   * prochain changement d etat cote serveur, c est-a-dire potentiellement jamais:
   * le serveur ne rediffuse un etat que lorsqu il change.
   */
  const lastState = useRef<ServerMessage | null>(null);
  const lastStart = useRef<ServerMessage | null>(null);
  const port = useRef<ReturnType<typeof createYouTubePlayer> | null>(null);
  /* Le lecteur brut, garde pour pouvoir le detruire en sortant de la room. */
  const playerRaw = useRef<InstanceType<YTPlayerCtor> | null>(null);
  const playerCreated = useRef(false);
  const [playerReady, setPlayerReady] = useState(false);
  /* Le cadre est-il a l ecran. Pilote a lui seul la duree de vie du lecteur. */
  const [frameMounted, setFrameMounted] = useState(false);
  /* Tout clic dans l application vaut geste utilisateur pour les conditions d utilisation. */
  const gestured = useRef(false);
  const loadedVideo = useRef<string | null>(null);

  const handle = useCallback((message: ServerMessage) => {
    const atMs = Date.now();
    if (session.current) session.current.onServerMessage(message, atMs);
    else early.current.push({ message, atMs });
    switch (message.type) {
      case "room_state": {
        /*
         * La trace se reecrit a chaque etat recu: le nom retenu est celui que le
         * serveur a valide et tronque, pas celui qu on croyait avoir envoye.
         */
        lastState.current = message;
        // Une pause enterre le depart commun: le rejouer relancerait la lecture.
        if (!message.playing) lastStart.current = null;
        const me = message.participants.find((p) => p.id === message.youAre);
        if (me) {
          saveResume(window.sessionStorage, {
            code: message.code,
            participantId: message.youAre,
            name: me.name,
          });
        }
        pendingResume.current = null;
        setResuming(false);
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
      }
      case "waiting":
        // Le depart precedent est revolu: une barriere ouverte le remplace.
        lastStart.current = null;
        setWaitingFor(message.waitingFor);
        setWaitingSince((previous) => previous ?? Date.now());
        return;
      case "common_start":
        lastStart.current = message;
        setWaitingFor([]);
        setWaitingSince(null);
        return;
      case "error":
        /*
         * Une erreur pendant la reprise dit que la room a disparu ou n a plus de place.
         * Ce n est pas une faute de l utilisateur: on efface la trace devenue fausse et
         * on rend l accueil avec une phrase lisible, plutot que le message technique.
         * Apres une coupure plus longue que le delai de grace, on quitte aussi l ecran
         * de room: il montrerait une room que le serveur a detruite.
         */
        if (pendingResume.current !== null) {
          pendingResume.current = null;
          clearResume(window.sessionStorage);
          setResuming(false);
          setRoom(null);
          setError("Ta room precedente n existe plus.");
          return;
        }
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
      onOpen: () => {
        setConnected(true);
        /*
         * On se remet dans sa room sans rien demander, au chargement comme apres une
         * coupure reseau: le transport rouvre la socket tout seul et rappelle onOpen,
         * et la trace, reecrite a chaque room_state, dit toujours ou on etait. Le
         * serveur garde la place le temps du delai de grace: y revenir en une seconde,
         * plutot que le temps de retaper un code, est ce qui rend ce delai suffisant.
         * Passer par pendingResume garde le meme chemin d erreur qu au chargement.
         */
        const trace = pendingResume.current ?? readResume(window.sessionStorage);
        if (trace) {
          pendingResume.current = trace;
          socket.send({ type: "join_room", ...trace });
        }
      },
      onClose: () => setConnected(false),
      onProtocolError: (reason) => setError(`Message du serveur illisible: ${reason}`),
    });
    transport.current = socket;
    return () => socket.close();
  }, [handle]);

  /*
   * Filet: un serveur qui ne repond pas laisserait l ecran de reprise indefiniment.
   * La trace n est pas effacee — l echec n est pas concluant, et le code memorise sert
   * encore si l utilisateur rejoint a la main.
   */
  useEffect(() => {
    if (!resuming) return;
    const timer = setTimeout(() => {
      pendingResume.current = null;
      setResuming(false);
    }, 5_000);
    return () => clearTimeout(timer);
  }, [resuming]);

  /*
   * Une erreur s efface toute seule. Un bandeau qui reste affiche apres coup devient
   * du decor: on finit par ne plus le lire, y compris quand il dit quelque chose.
   */
  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);

  // Qui est connecte, s il y a quelqu un. Un serveur sans identifiants Google repond
  // 404 ici, ce qui vaut invite: l application reste entiere sans compte (R3).
  useEffect(() => {
    void fetchAccount().then(setAccount);
  }, []);

  // L historique se recharge a chaque visite de l ecran: une ecoute vient peut-etre
  // de s y ajouter. L ecran playlists le lit aussi, comme source d ajout (R8).
  useEffect(() => {
    if (path !== "/historique" && path !== "/playlists") return;
    setHistory(null);
    void fetchHistory().then(setHistory);
  }, [path]);

  // Les playlists servent deux ecrans: le leur, et la room pour l envoi (R9).
  const inRoom = room !== null;
  useEffect(() => {
    if (!account) return;
    if (path !== "/playlists" && !inRoom) return;
    void fetchPlaylists().then(setPlaylists);
  }, [path, account, inRoom]);

  useEffect(() => {
    if (selectedPlaylist === null) return;
    setPlaylistItems(null);
    void fetchPlaylistItems(selectedPlaylist).then(setPlaylistItems);
  }, [selectedPlaylist]);

  /*
   * Retour d une connexion qui n a pas abouti (R12): refus du consentement, erreur
   * Google, cookie perime. On le dit une fois puis on nettoie l adresse, sinon le
   * message revient a chaque rafraichissement.
   */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("auth") !== "failed") return;
    setError("La connexion Google n a pas abouti. Tu peux continuer en invite.");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Une horloge d affichage: la barre d etat montre une duree qui doit avancer.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // La face s applique a la racine: les tokens CSS font tout le travail.
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    window.localStorage.setItem("syncmusic.theme", theme);
  }, [theme]);

  const currentVideoId =
    room?.queue.find((q) => q.itemId === room.currentItemId)?.videoId ?? null;

  /*
   * Creation du lecteur, une seule fois, des qu un morceau courant existe.
   * Un lecteur cree sans identifiant de video n emet jamais onReady: il n a rien a
   * preparer, et le cadre reste noir sans la moindre erreur.
   */
  /*
   * Defait le lecteur et tout ce qui en depend.
   *
   * Sans cela, revenir dans la vue de room apres l avoir quittee (un aller-retour par
   * /compte suffit) laissait le garde de creation arme sur un lecteur que React venait
   * d emporter: cadre vide, interface qui annonce « en lecture », et pas la moindre
   * erreur pour le dire.
   */
  const destroyPlayer = useCallback(() => {
    try {
      playerRaw.current?.destroy();
    } catch {
      // Le cadre a pu partir avant nous: il n y a alors plus rien a detruire.
    }
    playerRaw.current = null;
    playerCreated.current = false;
    port.current = null;
    session.current = null;
    loadedVideo.current = null;
    early.current = [];
    setPlayerReady(false);
  }, []);

  // Le lecteur vit exactement le temps que son cadre est a l ecran, ni plus ni moins.
  useEffect(() => {
    if (frameMounted) return;
    destroyPlayer();
  }, [frameMounted, destroyPlayer]);

  useEffect(() => {
    if (!frameMounted || currentVideoId === null || playerCreated.current) return;
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
            /*
             * L etat de la room d abord, la timeline ensuite: une session vierge doit
             * savoir qui elle est avant de pouvoir suivre quoi que ce soit. Rejouer
             * un depart commun ancien est exact par construction, sa position se
             * recalcule depuis l horloge serveur, pas depuis son age.
             */
            const atMs = Date.now();
            for (const past of [lastState.current, lastStart.current]) {
              if (past !== null) session.current.onServerMessage(past, atMs);
            }
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
      playerRaw.current = raw;
    });

    return () => {
      cancelled = true;
      /* Annule avant meme que le lecteur existe: le garde doit retomber, sinon plus
         rien ne le creera jamais. */
      if (playerRaw.current === null) playerCreated.current = false;
    };
  }, [currentVideoId, frameMounted]);

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

  /*
   * Les ecrans de compte se rendent ici, pas dans un composant monte a part: la socket
   * vit dans cet effet, et une route qui demonterait App ferait sortir de la room le
   * temps d aller regarder son nom.
   */
  if (path === "/playlists") {
    if (account === undefined) {
      return (
        <main className="join">
          <h1>Mes playlists</h1>
          <p className="join__baseline">Un instant...</p>
        </main>
      );
    }
    const refreshPlaylists = () => void fetchPlaylists().then(setPlaylists);
    const addToSelected = (item: { videoId: string; title: string | null }) => {
      const target = selectedPlaylist;
      if (target === null) return;
      void addPlaylistItem(target, item).then((result) => {
        if (!result.ok) return setError(result.reason);
        setError(null);
        void fetchPlaylistItems(target).then(setPlaylistItems);
        refreshPlaylists(); // le compteur de morceaux a change
      });
    };
    return (
      <Playlists
        account={account}
        playlists={playlists}
        selectedId={selectedPlaylist}
        items={playlistItems}
        recent={history?.entries ?? null}
        error={error}
        onSelect={setSelectedPlaylist}
        onCreate={(name) => {
          void createPlaylist(name).then((result) => {
            if (!result.ok) return setError(result.reason);
            setError(null);
            setSelectedPlaylist(result.value.id);
            refreshPlaylists();
          });
        }}
        onAddLink={(rawLink) => {
          const parsed = parseVideoId(rawLink);
          if (!parsed.ok) return setError(parsed.reason);
          addToSelected({ videoId: parsed.videoId, title: null });
        }}
        onAddEntry={(entry) => addToSelected({ videoId: entry.videoId, title: entry.title })}
        /* La recherche connait deja le titre: l ecrire evite un aller-retour oEmbed
           pour une information qu on tient. */
        onAddResult={(result) => addToSelected({ videoId: result.videoId, title: result.title })}
      />
    );
  }

  if (path === "/historique") {
    if (account === undefined) {
      return (
        <main className="join">
          <h1>Mon historique</h1>
          <p className="join__baseline">Un instant...</p>
        </main>
      );
    }
    return (
      <History
        account={account}
        page={history}
        nowMs={now}
        onMore={() => {
          const cursor = history?.nextBefore;
          if (!cursor) return;
          void fetchHistory(cursor).then((next) => {
            if (next === null) return;
            setHistory((previous) => previous === null ? next : {
              entries: [...previous.entries, ...next.entries],
              nextBefore: next.nextBefore,
            });
          });
        }}
      />
    );
  }

  if (path === "/compte") {
    // Attendre la reponse avant de monter l ecran: il pre-remplit le champ avec le nom.
    if (account === undefined) {
      return (
        <main className="join">
          <h1>Mon compte</h1>
          <p className="join__baseline">Un instant...</p>
        </main>
      );
    }
    return (
      <AccountScreen
        account={account}
        error={error}
        theme={theme}
        onTheme={setTheme}
        onSave={(name) => {
          void saveAccountName(name).then((result) => {
            if (result.ok) { setAccount({ name: result.name }); setError(null); }
            else setError(result.reason);
          });
        }}
        onLogout={() => {
          /* Rechargement volontaire: la socket ouverte garde son identite jusqu a sa
           * fermeture, donc se deconnecter sans recharger laisserait le nom de compte
           * en room. */
          void logout().then(() => window.location.assign("/"));
        }}
      />
    );
  }

  if (room === null) {
    /*
     * Pendant la reprise, ne pas montrer le formulaire: il clignoterait une demi-seconde
     * avant de disparaitre, et donnerait a croire qu on a ete sorti de sa room.
     */
    if (resuming) {
      return (
        <main className="join">
          <h1>SyncMusic</h1>
          <p className="join__baseline">On te remet dans ta room...</p>
        </main>
      );
    }

    /*
     * Le pseudo retenu est celui d un invite, jamais le nom d un compte: sinon se
     * connecter une fois effacerait le pseudo qu on retrouve en se deconnectant.
     */
    const remember = (name: string) => {
      if (account) return;
      window.localStorage.setItem("syncmusic.pseudo", name);
      setPseudo(name);
    };
    /*
     * Chemin manuel, emprunte quand la reprise automatique n a pas abouti (serveur
     * muet, ou room rejointe a la main). On ne rend son identifiant que pour la room a
     * laquelle il appartient: ailleurs il ne veut rien dire.
     */
    const trace = readResume(window.sessionStorage);
    return (
      <RoomJoin
        account={account}
        initialName={pseudo}
        onCreate={(name) => { remember(name); send?.({ type: "create_room", name }); }}
        onJoin={(code, name) => {
          remember(name);
          const participantId = trace?.code === code ? trace.participantId : undefined;
          send?.({ type: "join_room", code, name, participantId });
        }}
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

  /*
   * Sortie volontaire. La trace de reprise doit partir avec la room: sans cela, la
   * prochaine reouverture de socket nous y remettrait, ce qui est exactement son
   * travail. Le lecteur, lui, se defait tout seul quand son cadre quitte l ecran.
   *
   * On n attend aucune confirmation du serveur: le message part sur une socket qui
   * garantit l ordre, et rester bloque sur un ecran de room que l on vient de quitter
   * serait pire que le cas rare ou il ne partirait pas (coupure reseau au meme
   * instant). La place se libererait alors d elle-meme a la fin du delai de grace.
   */
  function leaveRoom(): void {
    send?.({ type: "leave_room" });
    clearResume(window.sessionStorage);
    pendingResume.current = null;
    // La room quittee ne doit rien souffler a la suivante.
    lastState.current = null;
    lastStart.current = null;

    setRoom(null);
    setWaitingFor([]);
    setWaitingSince(null);
    setPairGap(null);
    setDrift([]);
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
        <LeaveButton onLeave={leaveRoom} alone={others.length === 0} />
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
        <PlayerFrame onMountedChange={setFrameMounted} />
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

      <section className="panel">
        <div className="panel__head"><h2>Recherche</h2></div>
        {/* Le titre n est pas transmis: le serveur le recupere comme pour un lien
            colle, et une seule source de titre vaut mieux que deux qui divergent. */}
        <Search
          actionLabel="Ajouter"
          onPick={(result) => {
            send?.({ type: "queue_add", videoId: result.videoId });
            setError(null);
          }}
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

        {/* L envoi d une playlist se comporte comme des ajouts ordinaires (R9). */}
        {account ? (
          <SendPlaylist
            playlists={playlists}
            onSend={(playlistId) => send?.({ type: "send_playlist", playlistId })}
          />
        ) : null}

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
