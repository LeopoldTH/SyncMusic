/*
 * Garde de quota de la recherche. Pur et sans horloge implicite: chaque appel recoit
 * l instant courant, ce qui rend la bascule de journee testable sans attendre minuit.
 *
 * Deux plafonds, parce qu il y a deux menaces distinctes:
 *
 *  - le plafond quotidien protege la ressource elle-meme. Le quota Google est de
 *    100 recherches par jour pour toute l application, et c est un mur: passe ce
 *    point la recherche est morte jusqu au lendemain. On s arrete legerement avant,
 *    pour rendre un message lisible plutot que le 403 brut de Google;
 *  - le plafond par client empeche un seul visiteur de consommer la journee entiere.
 *    Sans lui, le plafond quotidien serait atteint par le premier script venu, et le
 *    premier plafond ne protegerait plus personne.
 */

/*
 * Le quota Google se remet a zero a minuit, heure du Pacifique. Aligner la fenetre
 * sur la sienne evite le pire cas: un compteur local qui repart alors que celui de
 * Google court encore, et une journee ou l application promet des recherches que
 * l API refuse.
 */
const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type SearchRefusal = "daily" | "client" | "clientDaily";

export interface SearchBudgetOptions {
  /** Recherches par journee Pacifique, pour toute l application. */
  dailyBudget: number;
  perClientWindowMs: number;
  perClientMax: number;
  /*
   * Plafond par client et par journee. Sans lui, le plafond par fenetre ne borne rien:
   * quarante recherches toutes les dix minutes font deux cent quarante par heure, de
   * quoi vider les quatre-vingt-dix du jour en vingt minutes a une seule personne. La
   * fenetre lisse la cadence, ce plafond-ci repartit la journee.
   */
  perClientDaily: number;
}

export function createSearchBudget(options: SearchBudgetOptions) {
  let day = "";
  let spentToday = 0;
  /** Horodatages des recherches recentes, par client. */
  const recent = new Map<string, number[]>();
  /** Recherches du jour par client, remise a zero avec le compteur global. */
  const spentTodayBy = new Map<string, number>();

  function rollOver(nowMs: number): void {
    const today = PACIFIC_DAY.format(new Date(nowMs));
    if (today === day) return;
    day = today;
    spentToday = 0;
    spentTodayBy.clear();
  }

  return {
    /** Consomme une recherche, ou dit pourquoi elle est refusee. */
    take(clientKey: string, nowMs: number): { ok: true } | { ok: false; reason: SearchRefusal } {
      rollOver(nowMs);
      if (spentToday >= options.dailyBudget) return { ok: false, reason: "daily" };
      if ((spentTodayBy.get(clientKey) ?? 0) >= options.perClientDaily) {
        return { ok: false, reason: "clientDaily" };
      }

      const since = nowMs - options.perClientWindowMs;
      const kept = (recent.get(clientKey) ?? []).filter((at) => at > since);
      if (kept.length >= options.perClientMax) {
        // La fenetre nettoyee est conservee: le refus ne doit pas repousser l echeance.
        recent.set(clientKey, kept);
        return { ok: false, reason: "client" };
      }

      kept.push(nowMs);
      recent.set(clientKey, kept);
      spentToday += 1;
      spentTodayBy.set(clientKey, (spentTodayBy.get(clientKey) ?? 0) + 1);
      return { ok: true };
    },

    /*
     * Oublie les clients qui ne cherchent plus. Sans ce passage, la table grandit
     * avec le nombre de visiteurs et ne redescend jamais.
     */
    sweep(nowMs: number): void {
      const since = nowMs - options.perClientWindowMs;
      for (const [key, times] of recent) {
        const kept = times.filter((at) => at > since);
        if (kept.length === 0) recent.delete(key);
        else recent.set(key, kept);
      }
    },

    /** Pour le diagnostic et les tests. */
    state(nowMs: number) {
      rollOver(nowMs);
      return { day, spentToday, clients: recent.size };
    },
  };
}
