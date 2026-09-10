import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCoalescer } from "./coalesce";

describe("regroupement des declenchements (U3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cent demandes rapprochees ne font qu un declenchement", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 250);

    for (let i = 0; i < 100; i++) coalescer.request();
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("une demande unique declenche apres la fenetre", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 250);

    coalescer.request();
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /*
   * La fenetre est fixe, pas glissante: sinon un flux continu de reponses la
   * repousserait indefiniment et la file ne se remplirait a l ecran qu a la toute fin.
   */
  it("des demandes continues declenchent regulierement, sans etre repoussees", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 250);

    // Une demande toutes les 50 ms pendant une seconde: le remplissage d une playlist.
    for (let tick = 0; tick < 20; tick++) {
      coalescer.request();
      vi.advanceTimersByTime(50);
    }

    /*
     * Une fenetre glissante n aurait jamais declenche: chaque demande repousserait
     * l echeance, et rien n arriverait a l ecran tant que les reponses tombent. C est
     * la propriete que ce test discrimine, pas le compte exact.
     */
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("flush declenche tout de suite ce qui attend", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 250);

    coalescer.request();
    coalescer.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  /* Un ajout un par un ne doit rien perdre en latence: sa reponse unique part aussitot. */
  it("une demande suivie d un flush ne subit aucun delai", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 10_000);

    coalescer.request();
    coalescer.flush();
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush sans rien en attente ne declenche pas", () => {
    const run = vi.fn();
    createCoalescer(run, 250).flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("flush apres un declenchement deja parti ne rejoue rien", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 250);

    coalescer.request();
    vi.advanceTimersByTime(250);
    coalescer.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("de nouvelles demandes apres un flush repartent sur une fenetre neuve", () => {
    const run = vi.fn();
    const coalescer = createCoalescer(run, 250);

    coalescer.request();
    coalescer.flush();
    coalescer.request();
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
