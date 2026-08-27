# À faire

Points remontés en usage réel, hors du plan initial.

## À traiter

- **Interface à soigner.** Mise en page mauvaise sur écran étroit, boutons qui débordent, champ d'ajout qui sort du cadre. La direction est maintenant tranchée : la charte « Console » (`docs/design/charte.md`, décidée le 27/08/2026) fixe tokens, typographie et règles, avec maquettes de tous les écrans. Reste le re-skin de `client/styles.css`, à mener avant ou avec la barre de recherche.
- **Rejoindre une room déjà commencée.** Un correctif est en place (le serveur tient sa timeline et ouvre un départ commun à l'arrivée, commit `9fe7f8c`) et vérifié à deux fenêtres. À reconfirmer en conditions réelles, sur deux machines.
- **Décalage audible autour de 200 ms.** Entendu à l'écoute téléphone + ordinateur le 23/08/2026 : l'écart s'entend sur les paroles. C'est déjà un résultat pour la mesure 6 de `docs/mesures-api-youtube.md` — le seuil audible est à 200 ms ou en dessous, alors que le tableau du protocole commençait à 200 ms en pensant que ce serait large.

  Le moteur ne corrige rien à cette valeur, et c'est voulu : le plancher de `client/sync/thresholds.ts` est à 300 ms. Il porte de plus sur l'écart de *chaque client à la timeline du serveur*, pas sur l'écart entre les deux participants — deux clients à 250 ms de la timeline, chacun de son côté, font 500 ms entre eux sans qu'aucun ne bouge. Ce plancher vient de la résolution de mesure (positions reçues toutes les 266 ms) : le baisser, c'est risquer de corriger du bruit. Vrai arbitrage, pas un réglage.

  **Avant de toucher au moindre seuil :** la sortie audio d'un téléphone, surtout en Bluetooth, ajoute facilement 100 à 200 ms à elle seule, et le réglage de latence de U9 existe pour ça. Lire l'écart sur la courbe de dérive plutôt que le juger à l'oreille, sinon on retouche le moteur pour compenser un appareil non calibré.
- **Reconnexion après une coupure réseau.** Un correctif est en place : `client/transport/socket.ts` rouvre la socket tout seul après une coupure (essais espacés de 1 à 15 s), et `App.tsx` rejoue la reprise de room à chaque réouverture via la trace de sessionStorage — le même chemin que le refresh. Si la coupure a dépassé le délai de grâce et que la room est morte, retour à l'accueil avec la phrase lisible habituelle. Le badge « Hors ligne — Reconnexion en cours » dit désormais la vérité. Couvert par `client/transport/socket.test.ts` ; à reconfirmer en conditions réelles (wifi coupé, téléphone en veille).

## Vérifié corrigé

- Pause qui ne s'appliquait qu'à un écran. Commit `7cb8ebd`.
- Reprise qui repartait du début du morceau. Commit `17534fd`.
- Première lecture refusée quand l'onglet est en arrière-plan. Commit `f00d856`.
- Rafraîchir la page sortait de la room, et la place gardée par le serveur rendait celle-ci injoignable jusqu'à sa destruction avec sa file. Un refresh n'en fait plus sortir du tout : l'onglet retient sa place et y revient seul. Commits `15f772e` et `e8b1f3e`, branche `fix/refresh-sort-de-la-room`, vérifié à deux fenêtres avec room pleine.

## Reste du plan

- Les mesures 5, 6 et 7 de `docs/mesures-api-youtube.md`, dont le seuil audible qui ne peut venir que d'une écoute à deux. Le déploiement (fait, voir ci-dessous) rend cette écoute possible sans tunnel.

## Fait

- U10, déploiement. L'app tourne sur Fly.io : `https://syncmusic-leopold.fly.dev` (2026-08-21). Repo public `https://github.com/LeopoldTH/SyncMusic`, CI verte. Gotchas du deploy dans `docs/solutions/workflow-issues/fly-launch-reecrit-la-config.md`.
