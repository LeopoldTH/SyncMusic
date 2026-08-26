# Écouter à deux, sans rien déployer

L'un de vous héberge, l'autre se connecte. Zéro coût, zéro compte à créer côté serveur.

## Côté hôte

Une seule fois, construire l'application :

```
npm install
npm run build
```

Puis, à chaque session, deux terminaux.

**Terminal 1, le serveur :**

```
npm start
```

Il sert l'application **et** les connexions temps réel sur le même port, `8787` par défaut. C'est ce qui permet de n'exposer qu'un seul tunnel.

**Terminal 2, le tunnel :**

```
ngrok http 8787
```

ngrok affiche une adresse en `https://quelque-chose.ngrok-free.dev`. C'est elle qu'on partage.

## Côté invité

Ouvrir l'adresse, cliquer une fois sur **Visit Site** sur l'écran d'avertissement de ngrok, choisir son pseudo, et saisir le code de room à quatre lettres.

## Ce qu'il faut savoir

- **L'adresse change à chaque redémarrage de ngrok.** C'est la contrainte de l'offre gratuite. Sans importance quand vous vous appelez pour jouer de toute façon.
- **L'écran d'avertissement se clique une fois par navigateur.** Il ne revient pas ensuite.
- **HTTPS est indispensable et vous l'avez.** ngrok le fournit, et le lecteur YouTube l'exige : sans lui, l'erreur 153 vous attend.
- **Le serveur ne tourne que tant que la machine de l'hôte est allumée.** C'est le compromis assumé de cette formule.

## Verrouiller l'origine

Le tunnel est public : n'importe qui connaissant l'adresse tombe sur l'application. Ce n'est pas grave en soi, il faut encore deviner un code de room, mais on peut restreindre les connexions temps réel à la seule origine du tunnel :

```
ALLOWED_ORIGIN=https://ton-adresse.ngrok-free.dev npm start
```

Non défini, toute origine est acceptée, ce qui est le bon réglage en développement local.

## Où vivent les données

Depuis le chantier comptes, le serveur ouvre une base SQLite à son démarrage : `data/syncmusic.db` sous le dossier du projet, sauf si `DB_PATH` en décide autrement. Le fichier et ses fichiers de travail WAL sont ignorés par git. En développement, rien à faire ; le supprimer repart d'une base vide.

```
DB_PATH=/chemin/vers/syncmusic.db npm start
```

En production, `DB_PATH` doit pointer dans le volume persistant (`/data` sur Fly.io, déjà réglé dans `fly.toml`). Ailleurs, la base repart de zéro à chaque redéploiement, comptes et historique compris.

## Pour une démonstration durable

Cette formule ne convient pas à un lien qu'on met sur un CV : l'adresse bouge et le service est éteint la plupart du temps. Ce déploiement existe désormais : `https://syncmusic-leopold.fly.dev` (Fly.io, réveil en une seconde au premier clic). Le tunnel ngrok reste l'option zéro-config quand on veut tester une version locale non déployée.
