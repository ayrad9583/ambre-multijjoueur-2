# Ambre 3724 · serveur en ligne (hébergement gratuit)

Contenu : `server.js` (serveur), `Ambre-3724-multijoueur.html` (le jeu), `package.json`, `render.yaml`.
Le serveur sert aussi le jeu : tes amis ouvrent simplement l'adresse web, sans rien installer.

## Mise en ligne sur Render (gratuit)
1. Crée un compte GitHub (github.com), puis un dépôt **public** vide, par ex. `ambre-3724`.
2. Dans le dépôt : « Add file » > « Upload files » : glisse les fichiers de ce dossier (sans le dossier lui-même), puis « Commit changes ».
3. Crée un compte sur render.com (connexion avec GitHub possible).
4. « New + » > **Blueprint** (ou « Web Service ») > choisis ton dépôt.
   - Blueprint : Render lit `render.yaml` et tout est déjà réglé (offre **Free**).
   - Web Service : Runtime Node, Build Command `echo ok`, Start Command `node server.js`, Instance Type **Free**.
5. Attends 2-4 minutes. Ton jeu est à `https://ambre-3724-xxxx.onrender.com/`.
6. Donne cette adresse à tes amis : ils l'ouvrent, choisissent un rôle et jouent.

## Ce que le serveur garde
- **Le monde** : graine (donc la carte), heure du jour, constructions de tous les joueurs.
- **Chaque joueur** : sac, outils, personnages réveillés, position… Ta progression est enregistrée sur le serveur toutes les ~10 secondes (et quand tu quittes), en plus de ton appareil. Tu retrouves ton personnage en revenant, même après un redémarrage du serveur, ou depuis un autre appareil avec ton **code de reprise** (affiché dans le menu Pause).
- Chaque serveur a son propre monde et son propre personnage : ta partie solo n'est jamais modifiée.

## Garder tout ça quand le serveur s'éteint (obligatoire en hébergement gratuit)
Le disque de l'offre gratuite est effacé à chaque arrêt. Le serveur sauvegarde donc tout dans un **Gist GitHub secret** (gratuit) et le recharge au démarrage.
1. Va sur gist.github.com, connecte-toi, crée un Gist **secret** : nom de fichier `world.json`, contenu `{}`. Clique sur « Create secret gist ».
2. Copie l'identifiant dans l'adresse du Gist (la longue suite de lettres et chiffres à la fin). C'est ton `GIST_ID`.
3. Sur GitHub : Settings > Developer settings > Personal access tokens > **Tokens (classic)** > Generate new token (classic). Coche uniquement la case **gist**, choisis une durée (ou « No expiration ») et copie le jeton. C'est ton `GITHUB_TOKEN`. Ne le partage à personne.
4. Dans Render : ton service > Environment > ajoute `GIST_ID` et `GITHUB_TOKEN`, puis sauvegarde (le serveur redémarre).
5. Vérifie dans les Logs : « Monde chargé depuis le Gist GitHub » ou « Gist GitHub vide : nouveau monde ». Si tu vois « Lecture du Gist impossible », vérifie l'identifiant et le jeton.
Les données sont envoyées au plus toutes les 15 secondes quand quelque chose change, et une dernière fois à l'arrêt du serveur. En cas de crash brutal, tu peux perdre ~15 secondes de progression.

## Jouer
Ouvre l'adresse du serveur, choisis un nom, rejoins. **Entrée** ouvre le chat. Tes amis apparaissent dans le monde avec leur nom.
Pour repartir de zéro, supprime le contenu du Gist (remets `{}`) : le serveur génère un nouveau monde.

## À savoir (offre gratuite)
- Après 15 min sans personne, le serveur s'endort ; le premier joueur qui revient attend ~1 minute.
- 750 heures gratuites par mois, largement suffisant pour un seul serveur.
- Renommer le serveur / changer le nombre de joueurs : variables d'environnement `SERVER_NAME`, `SERVER_MOTD`, `SERVER_MAX`.
- Sans Gist, le monde et les sauvegardes serveur sont perdus à l'arrêt (chaque joueur garde quand même sa copie locale, mais le monde est regénéré avec une nouvelle carte).
