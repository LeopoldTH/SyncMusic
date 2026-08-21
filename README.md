# SyncMusic

Écouter YouTube à deux, chacun chez soi, **en phase**. On crée une room, on partage un code à quatre lettres, on remplit une file de morceaux, et les deux lecteurs jouent la même chose au même instant — assez précisément pour qu'on puisse parler de la musique sans que l'un réagisse à un passage que l'autre n'a pas encore entendu.

## Le problème

Deux navigateurs qui lancent la même vidéo « en même temps » dérivent immédiatement : les horloges des machines ne sont pas les mêmes, le réseau n'a pas la même latence des deux côtés, et le lecteur YouTube embarqué démarre quand il veut, met en mémoire tampon quand il veut, et ne donne sa position qu'à sa propre cadence. Rien de tout cela n'est contrôlable. La seule approche qui tient est de **mesurer** ce que le lecteur fait réellement, puis de corriger l'écart — doucement, et seulement quand il est réel.

Le cœur du système :

- **Une horloge commune.** Chaque client sonde le serveur et estime le décalage entre son horloge et celle du serveur, façon NTP simplifiée. Toutes les décisions de position se prennent en temps serveur.
- **Des départs communs.** Personne ne démarre seul : le serveur pose une barrière, chacun se déclare prêt une fois sa vidéo chargée, et le serveur fixe alors un instant de départ commun dans le futur proche. Rejoindre une room en cours de lecture passe par la même barrière.
- **Une correction à étages.** Sous le plancher, on ne touche à rien (c'est du bruit de mesure). Entre plancher et plafond, on résorbe l'écart en modulant légèrement la vitesse de lecture, de façon inaudible. Au-delà du plafond, on saute directement à la bonne position.

## Les seuils viennent de mesures, pas d'intuitions

Le dossier [`spike/`](spike/) n'est pas un résidu de prototype : c'est le **banc de mesure** qui a fixé les constantes du moteur de synchronisation. Chaque seuil de [`client/sync/thresholds.ts`](client/sync/thresholds.ts) renvoie à une mesure de [`docs/mesures-api-youtube.md`](docs/mesures-api-youtube.md) ou porte sa justification écrite. Ce que le banc a établi (mesures du 19/08/2026) :

- **Le lecteur donne sa position toutes les 266 ms** (médiane ; p90 à 269 ms), quatre fois plus finement que la seconde supposée au départ. Le plancher de correction est arrondi à **300 ms** : sous cette valeur, la position lue est extrapolée localement, et « corriger » reviendrait à corriger du bruit d'API.
- **La grille de vitesses réellement acceptée a un pas de 0,05**, de 0,25× à 2,00× — bien plus fine que les huit valeurs que l'API annonce, qui ne décrivent que le menu de l'interface. C'est ce qui rend possible une correction discrète.
- **En onglet caché, les minuteries tombent à une par seconde** — et c'est le régime nominal du produit, puisqu'on écoute de la musique avec l'onglet en arrière-plan. La boucle de décision tourne donc à 1000 ms : plus vite ne s'exécuterait pas là où ça sert. Résultat clef du banc : une lecture **pilotée par le code fonctionne onglet caché** ; seule la toute première lecture exige un onglet visible et un geste de l'utilisateur.

On mesure plus finement (266 ms) qu'on ne décide (1000 ms) : ce sont deux grandeurs distinctes.

## Pourquoi la correction s'arrête où elle s'arrête

- **Sous 300 ms : ne rien faire.** L'écart mesuré est indistinguable du bruit de la mesure elle-même.
- **De 300 ms à 3 s : moduler la vitesse.** La fenêtre de résorption est volontairement longue (10 s) : personne n'attend la correction, et une fenêtre courte imposerait des vitesses audibles. Deux secondes d'écart se rattrapent ainsi à 1,20×, pas à 2×. Les auteurs de Jellyfin ont noté que cette correction « sonne mal sur les chansons » ; la réponse ici est d'allonger la fenêtre, pas d'abandonner l'étage.
- **Au-delà de 3 s : sauter.** Ce plafond est encore **provisoire** (valeur d'attente inspirée de Jellyfin) : le seuil réellement audible entre deux personnes qui ne partagent pas la même pièce ne peut venir que d'une écoute à deux, et le protocole de mesure attend dans `docs/mesures-api-youtube.md` (mesures 6 et 7).

Chaque participant dispose en plus d'un réglage local de latence (enceintes Bluetooth, chaîne audio), appliqué comme décalage constant sur la position cible, et d'une courbe de dérive pour voir l'écart en direct.

## Architecture en bref

- **TypeScript des deux côtés, protocole décrit une seule fois** ([`shared/protocol.ts`](shared/protocol.ts)), validé à l'exécution par schéma strict : un champ inconnu ou mal orthographié échoue bruyamment au lieu de dériver en silence.
- **Toute la logique de room est testée sans réseau** ([`server/room.ts`](server/room.ts)) : le transport WebSocket ([`server/index.ts`](server/index.ts)) ne fait que traduire des messages en appels.
- **Un seul port** sert l'application construite et les connexions temps réel — un seul processus à déployer, une seule adresse à partager.
- **Les rooms sont éphémères et vivent en mémoire.** Pas de compte, pas de base de données : un code à quatre lettres, et la room disparaît quand tout le monde est parti.

## Lancer en local

```
npm install
npm run build
npm start
```

L'application est sur `http://localhost:8787`. En développement, `npm run dev` (client Vite avec proxy) et `npm run dev:server` dans deux terminaux.

Vérifications : `npm run typecheck` et `npm test`.

## Déployer

L'application exige un processus long, des WebSockets maintenus et HTTPS (le lecteur YouTube le requiert — erreur 153 sinon). La configuration fournie vise Fly.io :

```
fly launch --no-deploy   # reprend fly.toml, choisir le nom d'app
fly deploy --ha=false    # UNE machine: les rooms vivent en memoire
```

Le `--ha=false` n'est pas une option d'économie : avec deux machines, deux participants peuvent atterrir sur deux mémoires différentes et ne jamais se voir. `ALLOWED_ORIGIN` dans `fly.toml` doit correspondre à l'adresse publique de l'app.

Pour une session ponctuelle sans rien déployer, voir [`docs/ecouter-a-deux.md`](docs/ecouter-a-deux.md) (tunnel ngrok depuis la machine de l'un des deux).

## État et limites assumées

- Deux participants par room — le cas d'usage, pas une limite technique profonde.
- Le plafond de saut (3 s) attend sa mesure à deux, protocole prêt dans `docs/mesures-api-youtube.md`.
- Comptes, historique et playlists sont un chantier séparé, planifié dans [`docs/plans/`](docs/plans/), posé en couche au-dessus des rooms sans changer leur nature éphémère.
