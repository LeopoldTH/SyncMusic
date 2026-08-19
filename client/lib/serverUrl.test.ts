import { describe, it, expect } from "vitest";
import { resolveServerUrl } from "./serverUrl";

describe("adresse du serveur", () => {
  it("prefere la valeur configuree", () => {
    const url = resolveServerUrl({ VITE_SERVER_URL: "wss://sync.example/ws" }, { protocol: "https:", host: "x" });
    expect(url).toBe("wss://sync.example/ws");
  });

  it("derive du site en clair", () => {
    expect(resolveServerUrl({}, { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/ws");
  });

  it("passe en connexion chiffree quand le site l est", () => {
    // Un site en https qui ouvrirait un socket en clair serait bloque par le navigateur.
    expect(resolveServerUrl({}, { protocol: "https:", host: "sync.example" })).toBe("wss://sync.example/ws");
  });
});
