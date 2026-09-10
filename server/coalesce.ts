/*
 * Regrouper des declenchements rapproches en un seul.
 *
 * Ne du remplissage de la file par oEmbed (U3): un envoi de playlist porte jusqu a
 * cent morceaux, et diffuser l etat a chaque reponse reserialise la file entiere vers
 * les deux sockets une fois par morceau, pour un artiste a jour sur une seule ligne a
 * chaque fois. La cadence fixe est le meme motif que la boucle de positions.
 *
 * Vit dans son propre module parce que index.ts ouvre un serveur des son import et ne
 * se teste pas: ici le comportement se prouve.
 */

export interface Coalescer {
  /** Demande un declenchement. Plusieurs appels rapproches n en produisent qu un. */
  request(): void;
  /** Declenche tout de suite ce qui attend, et annule la fenetre en cours. */
  flush(): void;
}

/*
 * Fenetre glissante non, fenetre fixe oui: le premier appel arme la fenetre, les
 * suivants s y fondent. Une fenetre glissante repousserait indefiniment la diffusion
 * tant que les reponses arrivent, et sur cent morceaux on ne verrait rien pendant
 * toute la duree du remplissage.
 */
export function createCoalescer(run: () => void, windowMs: number): Coalescer {
  let dirty = false;
  let pending: ReturnType<typeof setTimeout> | null = null;

  function fire(): void {
    pending = null;
    if (!dirty) return;
    dirty = false;
    run();
  }

  return {
    request(): void {
      dirty = true;
      if (pending === null) pending = setTimeout(fire, windowMs);
    },
    flush(): void {
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
      fire();
    },
  };
}
