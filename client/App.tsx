import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueItem, ServerMessage } from "../shared/protocol";
import { connect, type Transport } from "./transport/socket";
import { parseVideoId } from "./lib/videoId";
import { resolveServerUrl } from "./lib/serverUrl";
import { RoomJoin } from "./components/RoomJoin";
import { Queue } from "./components/Queue";
import { Controls } from "./components/Controls";
import { StatusBar } from "./components/StatusBar";
import { PlayerFrame } from "./components/PlayerFrame";

interface RoomView {
  code: string;
  youAre: string;
  participants: string[];
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

  const handle = useCallback((message: ServerMessage) => {
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
        // Le branchement du moteur sur ce message est l unite suivante.
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

  // Une horloge d affichage: la barre d etat montre une duree qui doit avancer.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const send = transport.current?.send.bind(transport.current);

  if (room === null) {
    return (
      <RoomJoin
        onCreate={() => send?.({ type: "create_room" })}
        onJoin={(code) => send?.({ type: "join_room", code })}
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

  return (
    <main className="app">
      <header className="app__header">
        <span className="app__code">Room {room.code}</span>
        <span className="app__peers">{room.participants.length} participant(s)</span>
      </header>

      <StatusBar
        connected={connected}
        waitingFor={waitingFor}
        waitingSinceMs={waitingSince}
        nowMs={now}
        pairGapMs={null}
      />

      <PlayerFrame />

      <Controls
        playing={room.playing}
        disabled={room.queue.length === 0}
        onPlay={() => send?.({ type: "control_transport", action: "play" })}
        onPause={() => send?.({ type: "control_transport", action: "pause" })}
        onNext={() => send?.({ type: "control_transport", action: "next" })}
        onPrevious={() => send?.({ type: "control_transport", action: "previous" })}
      />

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
          placeholder="Lien YouTube ou identifiant"
          aria-label="Lien YouTube"
        />
        <button type="submit">Ajouter</button>
      </form>

      {error === null ? null : <p className="error">{error}</p>}

      <Queue
        items={room.queue}
        currentItemId={room.currentItemId}
        onRemove={(itemId) => send?.({ type: "queue_remove", itemId })}
      />
    </main>
  );
}
