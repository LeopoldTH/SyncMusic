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
- **L'écran d'avertissement se clique une fois par navigateur**, quand il s'affiche. Voir la section suivante : sur mobile, il arrive qu'il ne s'affiche pas du tout.
- **HTTPS est indispensable et vous l'avez.** ngrok le fournit, et le lecteur YouTube l'exige : sans lui, l'erreur 153 vous attend.
- **Le serveur ne tourne que tant que la machine de l'hôte est allumée.** C'est le compromis assumé de cette formule.

## Quand ngrok donne une page blanche sur téléphone

Constaté le 23/08/2026, sur iPhone. Le symptôme est une page entièrement vide, sans bouton à cliquer.

Ce n'est pas votre application : c'est l'écran d'avertissement de ngrok (`ERR_NGROK_6024`), et il est lui-même **rendu en JavaScript**. Son corps est un `<div id="root">` vide, rempli par un script et des polices chargés depuis `assets.ngrok.com`. Si le téléphone n'atteint pas ce domaine — bloqueur de contenu, Private Relay, réseau capricieux — rien n'est dessiné, et le bouton « Visit Site » n'existe jamais. D'où l'impasse : on ne peut pas cliquer ce qui n'a pas été affiché.

Pour confirmer en dix secondes, ouvrir la même adresse en 4G, wifi coupé. Si elle s'affiche, c'est bien le réseau qui bloque les ressources de ngrok.

**La solution, quand ça arrivera : un tunnel sans page d'avertissement.**

```
brew install cloudflared
cloudflared tunnel --url http://localhost:8787
```

Il rend une adresse `https://…trycloudflare.com`, en HTTPS, sans aucun interstitiel et sans compte à créer. On ouvre, on est sur l'application.

Ça vaut l'installation dès qu'on enchaîne les essais sur téléphone. Tant qu'on ne fait que déployer pour tester, ngrok reste inutile et cette section peut dormir.

## Verrouiller l'origine

Le tunnel est public : n'importe qui connaissant l'adresse tombe sur l'application. Ce n'est pas grave en soi, il faut encore deviner un code de room, mais on peut restreindre les connexions temps réel à la seule origine du tunnel :

```
ALLOWED_ORIGIN=https://ton-adresse.ngrok-free.dev npm start
```

Non défini, toute origine est acceptée, ce qui est le bon réglage en développement local.

## Pour une démonstration durable

Cette formule ne convient pas à un lien qu'on met sur un CV : l'adresse bouge et le service est éteint la plupart du temps. Ce déploiement existe désormais : `https://syncmusic-leopold.fly.dev` (Fly.io, réveil en une seconde au premier clic). Le tunnel ngrok reste l'option zéro-config quand on veut tester une version locale non déployée.
