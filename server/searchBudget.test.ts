import { describe, it, expect } from "vitest";
import { createSearchBudget } from "./searchBudget";

const OPTIONS = { dailyBudget: 5, perClientWindowMs: 10 * 60_000, perClientMax: 3 };

/** 2026-08-29 12:00 UTC, soit le 29 aout au matin heure du Pacifique. */
const T0 = Date.UTC(2026, 7, 29, 12, 0, 0);
/** Meme journee Pacifique, quelques heures plus tard. */
const T_PLUS_6H = T0 + 6 * 3_600_000;
/** Lendemain, apres minuit Pacifique (soit 08:00 UTC le 30). */
const NEXT_DAY = Date.UTC(2026, 7, 30, 9, 0, 0);

describe("plafond par client", () => {
  it("laisse passer jusqu au plafond puis refuse", () => {
    const budget = createSearchBudget(OPTIONS);
    for (let i = 0; i < 3; i++) expect(budget.take("a", T0 + i).ok).toBe(true);

    const refused = budget.take("a", T0 + 3);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("client");
  });

  it("ne penalise pas un autre client", () => {
    const budget = createSearchBudget(OPTIONS);
    for (let i = 0; i < 3; i++) budget.take("a", T0 + i);
    expect(budget.take("b", T0 + 4).ok).toBe(true);
  });

  it("rouvre une fois la fenetre glissee", () => {
    const budget = createSearchBudget(OPTIONS);
    for (let i = 0; i < 3; i++) budget.take("a", T0 + i);
    expect(budget.take("a", T0 + OPTIONS.perClientWindowMs + 1).ok).toBe(true);
  });

  /*
   * Un refus ne consomme pas de quota Google: rien n a ete demande. Le compter
   * ferait mourir la journee sur des requetes qui n ont jamais atteint l API.
   */
  it("ne compte pas un refus dans le budget du jour", () => {
    const budget = createSearchBudget(OPTIONS);
    for (let i = 0; i < 5; i++) budget.take("a", T0 + i);
    expect(budget.state(T0).spentToday).toBe(3);
  });
});

describe("plafond quotidien", () => {
  it("refuse une fois la journee epuisee, meme pour un client neuf", () => {
    const budget = createSearchBudget(OPTIONS);
    // Cinq clients distincts, une recherche chacun: le budget du jour y passe.
    for (let i = 0; i < 5; i++) expect(budget.take(`client-${i}`, T0 + i).ok).toBe(true);

    const refused = budget.take("client-neuf", T0 + 10);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("daily");
  });

  it("tient toute la journee Pacifique sans se remettre a zero", () => {
    const budget = createSearchBudget(OPTIONS);
    for (let i = 0; i < 5; i++) budget.take(`client-${i}`, T0 + i);
    expect(budget.state(T_PLUS_6H).spentToday).toBe(5);
  });

  it("repart a zero au changement de journee Pacifique", () => {
    const budget = createSearchBudget(OPTIONS);
    for (let i = 0; i < 5; i++) budget.take(`client-${i}`, T0 + i);
    expect(budget.take("client-neuf", NEXT_DAY).ok).toBe(true);
    expect(budget.state(NEXT_DAY).spentToday).toBe(1);
  });
});

describe("nettoyage", () => {
  it("oublie les clients sortis de la fenetre", () => {
    const budget = createSearchBudget(OPTIONS);
    budget.take("a", T0);
    expect(budget.state(T0).clients).toBe(1);
    budget.sweep(T0 + OPTIONS.perClientWindowMs + 1);
    expect(budget.state(T0).clients).toBe(0);
  });
});
