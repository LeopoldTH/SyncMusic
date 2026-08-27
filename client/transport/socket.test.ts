import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./socket";

/*
 * Faux WebSocket: enregistre chaque instance creee et laisse le test declencher les
 * evenements. C est le meme principe que le faux lecteur des tests du moteur: la
 * logique de reconnexion se teste sans reseau et sans navigateur.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.fire("close", {});
  }

  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("reconnexion du transport", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rouvre la socket apres une coupure et rappelle onOpen", () => {
    const onOpen = vi.fn();
    connect("ws://test", { onMessage: () => {}, onOpen });
    const first = FakeWebSocket.instances[0]!;
    first.fire("open", {});
    expect(onOpen).toHaveBeenCalledTimes(1);

    first.fire("close", {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]!.fire("open", {});
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("espace les essais quand le serveur ne repond pas, puis repart vite apres un succes", () => {
    connect("ws://test", { onMessage: () => {} });
    FakeWebSocket.instances[0]!.fire("close", {});
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1]!.fire("close", {});

    // Le delai a double: une seconde ne suffit plus.
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Une ouverture reussie remet le delai au minimum.
    FakeWebSocket.instances[2]!.fire("open", {});
    FakeWebSocket.instances[2]!.fire("close", {});
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("ne rouvre jamais une socket fermee volontairement", () => {
    const transport = connect("ws://test", { onMessage: () => {} });
    FakeWebSocket.instances[0]!.fire("open", {});
    transport.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("n envoie rien pendant une coupure, puis envoie sur la nouvelle socket", () => {
    const transport = connect("ws://test", { onMessage: () => {} });
    const first = FakeWebSocket.instances[0]!;
    first.fire("open", {});
    first.fire("close", {});
    transport.send({ type: "clock_probe", clientSentAt: 1 });
    expect(first.sent).toHaveLength(0);

    vi.advanceTimersByTime(1_000);
    const second = FakeWebSocket.instances[1]!;
    second.fire("open", {});
    transport.send({ type: "clock_probe", clientSentAt: 2 });
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
  });
});
