# 🎨 Dessine & Devine

Un jeu multijoueur de dessin et de devinettes en temps réel, entièrement en français, inspiré de skribbl.io.

## Fonctionnalités

- Création de parties privées avec code à partager
- Rotation automatique des dessinateurs, plusieurs manches configurables
- Choix du mot parmi 3 propositions, temps de dessin réglable
- Canvas de dessin en temps réel (couleurs, tailles de pinceau, gomme, tout effacer)
- Chat avec détection automatique des bonnes réponses, indices "très proche !"
- Révélation progressive de lettres au fil du temps
- Score basé sur la rapidité de la réponse, classement final
- Banque de plus de 240 mots en français
- Interface responsive (bureau et mobile)

## Démarrage

```bash
npm install
npm start
```

Le serveur démarre sur `http://localhost:3000` (ou le port défini par `PORT`).

## Stack technique

- **Backend** : Node.js, Express, Socket.io
- **Frontend** : HTML/CSS/JS vanilla, Canvas API
