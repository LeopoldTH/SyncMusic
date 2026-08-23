# À faire

Points remontés en usage réel, hors du plan initial.

## À traiter

- **Interface à soigner.** Mise en page mauvaise sur écran étroit, boutons qui débordent, champ d'ajout qui sort du cadre. À faire une fois toutes les fonctionnalités en place, décision de Léopold.
- **Rejoindre une room déjà commencée.** Un correctif est en place (le serveur tient sa timeline et ouvre un départ commun à l'arrivée, commit `9fe7f8c`) et vérifié à deux fenêtres. À reconfirmer en conditions réelles, sur deux machines.

## Vérifié corrigé

- Pause qui ne s'appliquait qu'à un écran. Commit `7cb8ebd`.
- Reprise qui repartait du début du morceau. Commit `17534fd`.
- Première lecture refusée quand l'onglet est en arrière-plan. Commit `f00d856`.
- Rafraîchir la page sortait de la room, et la place gardée par le serveur rendait celle-ci injoignable jusqu'à sa destruction avec sa file. Un refresh n'en fait plus sortir du tout : l'onglet retient sa place et y revient seul. Commits `15f772e` et `e8b1f3e`, branche `fix/refresh-sort-de-la-room`, vérifié à deux fenêtres avec room pleine.

## Reste du plan

- Les mesures 5, 6 et 7 de `docs/mesures-api-youtube.md`, dont le seuil audible qui ne peut venir que d'une écoute à deux. Le déploiement (fait, voir ci-dessous) rend cette écoute possible sans tunnel.

## Fait

- U10, déploiement. L'app tourne sur Fly.io : `https://syncmusic-leopold.fly.dev` (2026-08-21). Repo public `https://github.com/LeopoldTH/SyncMusic`, CI verte. Gotchas du deploy dans `docs/solutions/workflow-issues/fly-launch-reecrit-la-config.md`.
