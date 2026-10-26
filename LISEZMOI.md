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

## À savoir (offre gratuite)
- Après 15 min sans personne, le serveur s'endort ; le premier joueur qui revient attend ~1 minute.
- Le disque est temporaire : le monde partagé n'est pas gardé quand le serveur s'endort ou redémarre.
  Le premier joueur qui se reconnecte le recrée à partir de **sa propre sauvegarde locale** (garde la même personne en premier).
- 750 heures gratuites par mois, largement suffisant pour un seul serveur.
- Renommer le serveur / changer le nombre de joueurs : variables d'environnement `SERVER_NAME`, `SERVER_MOTD`, `SERVER_MAX` dans Render.
