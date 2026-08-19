import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBar } from "./StatusBar";

describe("barre d etat", () => {
  it("nomme qui on attend et depuis combien de temps", () => {
    const html = renderToStaticMarkup(
      <StatusBar connected waitingFor={["pote"]} waitingSinceMs={10_000} nowMs={22_000} pairGapMs={null} />
    );
    expect(html).toContain("pote");
    expect(html).toContain("12 s");
  });

  it("annonce l ecart mesure quand tout va bien", () => {
    const html = renderToStaticMarkup(
      <StatusBar connected waitingFor={[]} waitingSinceMs={null} nowMs={0} pairGapMs={180.4} />
    );
    expect(html).toContain("Synchronise");
    expect(html).toContain("180 ms");
  });

  it("signale la perte de connexion avant tout le reste", () => {
    const html = renderToStaticMarkup(
      <StatusBar connected={false} waitingFor={["pote"]} waitingSinceMs={0} nowMs={5_000} pairGapMs={null} />
    );
    expect(html).toContain("Connexion perdue");
    expect(html).not.toContain("pote");
  });
});
