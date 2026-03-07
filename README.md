# Darts Championship PWA

Application PWA pour tournoi de flechettes, optimisee tablette/mobile:

- 18 joueurs -> 9 binomes aleatoires
- 3 poules de 3 equipes
- Top 8 en phase finale: 1/4, 1/2, finale
- Match en BO3 legs: `501`, `cricket`, puis `301` si egalite 1-1
- Gestion statut match: `En attente`, `En cours`, `Termine`
- Renommage equipe + photo equipe
- Sauvegarde locale via `localStorage` (scores et tournoi conserves au refresh)
- Son de victoire en fin de match
- Sync multi-ecrans via Supabase Realtime
- Verrou arbitre: un seul poste en ecriture, tous les autres en lecture

## Lancer en local

```bash
npm install
npm run dev
```

## Build production

```bash
npm run build
npm run preview
```

Le build PWA genere notamment `dist/sw.js` et `dist/manifest.webmanifest`.

## Mode multi-appareils (Supabase)

### 1. Variables d'environnement

Copie `.env.example` vers `.env` et renseigne:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

### 2. Base de donnees

Dans Supabase SQL Editor, execute `supabase/schema.sql`.

Ce script cree:

- `tournament_state` pour l'etat global du tournoi
- `referee_lock` pour le verrou d'ecriture arbitre

### 3. Fonctionnement en tournoi

- Tous les joueurs/cibles ouvrent la meme URL PWA
- Un arbitre clique `Prendre role arbitre`
- Seul l'arbitre actif peut modifier scores/statuts
- Les autres ecrans recoivent les updates en temps reel
- Le lock arbitre expire automatiquement (TTL 20 min) si l'app arbitre ne maintient plus la session

## Deploiement web (simple)

Tu peux deployer le dossier `dist/` sur:

- Vercel
- Netlify
- Cloudflare Pages
- Firebase Hosting

Exemple Vercel:

```bash
npm i -g vercel
vercel
```

Pense a ajouter les variables `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` dans les settings du fournisseur d'hebergement.

## Installation mobile / PC (PWA)

Quand l'app est en ligne en HTTPS:

- Android (Chrome): menu navigateur -> `Installer l'application`
- Windows/PC (Edge ou Chrome): icone `Installer` dans la barre d'URL

L'app fonctionne ensuite comme une app native (icone, plein ecran, mode hors ligne de base grace au service worker).

## Stack technique

- React + TypeScript + Vite
- Tailwind CSS v4
- vite-plugin-pwa
- TanStack Query
