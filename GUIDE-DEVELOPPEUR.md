# Guide développeur — Wisecom Control Room

> **Document de passation clef en main.**
> Objectif : permettre à un développeur de reprendre, maintenir et faire évoluer le dashboard
> de supervision temps réel **sans connaissance préalable du projet**. Tout est décrit :
> architecture, sources de données (API INO), méthode de calcul de chaque indicateur,
> affichage, déploiement, et pièges connus.
>
> Version applicative : **v2.1** · Dernière calibration métier : **10/06/2026**
> Pile : **Node.js ≥ 18 (zéro dépendance npm)** + **HTML/CSS/JS vanilla** servi en statique.

---

## Table des matières

1. [Vue d'ensemble en 2 minutes](#1-vue-densemble-en-2-minutes)
2. [Architecture & flux de données](#2-architecture--flux-de-données)
3. [Arborescence du dépôt](#3-arborescence-du-dépôt)
4. [Installation & déploiement (Railway)](#4-installation--déploiement-railway)
5. [Authentification & sécurité](#5-authentification--sécurité)
6. [La source de données : l'API INO](#6-la-source-de-données-lapi-ino)
7. [Routes du serveur (référence complète)](#7-routes-du-serveur-référence-complète)
8. [Configuration des campagnes & files](#8-configuration-des-campagnes--files)
9. [La méthode de calcul des indicateurs (le cœur)](#9-la-méthode-de-calcul-des-indicateurs-le-cœur)
10. [L'affichage côté client](#10-laffichage-côté-client)
11. [Filtres, vues sauvegardées & persistance](#11-filtres-vues-sauvegardées--persistance)
12. [Compétences agents (le module le plus fragile)](#12-compétences-agents-le-module-le-plus-fragile)
13. [Robustesse & « mode honnête »](#13-robustesse--mode-honnête)
14. [Exports (PDF / Excel / CSV)](#14-exports-pdf--excel--csv)
15. [Recettes de maintenance courantes](#15-recettes-de-maintenance-courantes)
16. [Dépannage / FAQ](#16-dépannage--faq)
17. [Glossaire métier](#17-glossaire-métier)

---

## 1. Vue d'ensemble en 2 minutes

Le **Control Room** est un tableau de bord de supervision d'un **centre d'appels multi-clients**
(« campagnes »). Il interroge l'API du logiciel de téléphonie **INO / Unicity**
(`wisecom.unicity.io`), agrège les historiques d'appels de la journée, et présente :

- des **KPI temps réel** (Qualité de Service, flux reçus/traités/manqués, DMC/DMT, occupation, etc.) ;
- un **tableau agent par agent** (appels, durées, productivité, compétences) ;
- des **graphiques de volume par tranche de 30 min** ;
- une **matrice de compétences** ;
- un **export WhatsApp** (synthèse formatée pour le reporting quotidien) ;
- un panneau **d'alertes** (staffing, astreinte, GSM).

**Principe directeur du projet — le « mode honnête » :** on n'affiche **jamais** une valeur inventée.
Si INO ne fournit pas une donnée, on affiche `n.d.` ; si un appel réseau échoue, on le signale
au lieu de faire passer un échec pour « 0 appel ». Ce principe est répété partout dans le code
et doit être préservé dans toute évolution.

**Particularités structurantes à retenir absolument :**

| Fait | Conséquence |
|------|-------------|
| Le serveur n'a **aucune base de données d'appels** : il relit les **historiques INO** à chaque requête. | Toute donnée est recalculée à la volée, jamais stockée. |
| La liste des agents est construite **uniquement à partir des appels** (`/call/in` + `/call/out`). | Un agent connecté mais **sans aucun appel** sur la fenêtre **n'apparaît pas**. C'est la cause de la majorité des « bugs » d'affichage. |
| Les **KPI cartes** (QS, flux…) viennent des **flux de file** agrégés serveur, indépendamment du tableau agent. | Les cartes peuvent afficher des chiffres alors que le tableau est vide (filtre trop restrictif) — ce n'est pas une incohérence. |
| Zéro dépendance npm. | Aucun `node_modules`, aucun build. `node server.js` suffit. |

---

## 2. Architecture & flux de données

```
┌────────────────┐        HTTPS (Bearer/Basic + X-EKO-Api-Key)        ┌──────────────────────┐
│                │ ─────────────────────────────────────────────────▶ │   API INO / Unicity   │
│   server.js    │   /api/auth, /call/in/histories, /call/out/...      │  wisecom.unicity.io   │
│  (Node http)   │ ◀───────────────────────────────────────────────── │                      │
│                │            JSON (histories[], agents…)              └──────────────────────┘
│                │
│  • Auth 2FA    │        HTTP (cookie session) + SSE /events
│  • Agrégations │ ◀────────────────────────────────────────────────┐
│  • /agents-day │                                                   │
│  • /api/*      │ ─────────────────────────────────────────────────▶ ┌──────────────────────┐
└───────┬────────┘   sert dashboard.html + JSON agrégé               │     dashboard.html    │
        │                                                            │  (SPA vanilla JS)     │
        │  fichier JSON local (réglages partagés)                    │  • KPI / tableau      │
        ▼                                                            │  • graphiques         │
┌────────────────┐                                                   │  • exports PDF/Excel  │
│ data/shared_   │                                                   └──────────────────────┘
│ store.json     │
└────────────────┘
```

**Chaîne complète d'un rafraîchissement** (ce qui se passe quand le superviseur clique « ↺ Actualiser ») :

1. **Client** : `refreshFromINO()` → `loadAgentsFromAPI()` appelle
   `GET /agents-day?date=…&dateFin=…&hDeb=…&hFin=…`.
2. **Serveur** : `fetchAgentsDay()` obtient un token INO (`getToken`), puis appelle pour chaque jour
   `POST /call/in/histories` **et** `POST /call/out/histories` (en parallèle).
3. **Serveur** : la fonction `proc(h, type)` parcourt chaque ligne d'historique et alimente :
   - les compteurs de **flux globaux** (`fluxRecusIn`, `fluxDecroches`, `fluxAbandons`, `fluxSortants`) ;
   - les **flux par campagne** (`fluxCamps`, avec exclusion des horaires de fermeture) ;
   - l'objet **agent** (`agents[k]`) : appels, durées, qualifications, files, sparklines ;
   - les **créneaux de 30 min** (`slotsMap`) pour le graphique.
4. **Serveur** : renvoie un JSON `{agents:[…], slots:[…], flux:{…}, fluxCampagnes:{…}, joursEchec:[…]}`.
5. **Client** : `loadAgentsFromAPI()` enrichit chaque agent (campagne, % réalisé, occupation, mails)
   puis `render()` redessine KPI + tableau + graphiques.
6. En parallèle (fire-and-forget) : `loadQueueStatus()` (`/api/queues-status`) pour les cartes de files,
   et `refreshSkills()` pour les compétences.

> **SSE (`/events`)** sert **uniquement de voyant de connexion INO**. Il ne déclenche **aucun**
> rechargement automatique (sinon la sélection de filtres serait écrasée toutes les 30 s).
> Le rafraîchissement des agents est **100 % manuel** (bouton ou changement de date).

---

## 3. Arborescence du dépôt

```
wisecom-control-room/
├── server.js              ← TOUT le backend (1 fichier, ~1490 lignes) : auth, routes, agrégations INO
├── dashboard.html         ← LE dashboard principal (~6430 lignes) : UI + calculs client + exports
├── queues_config.js       ← SOURCE UNIQUE : campagnes (CAMPS), mapping files (QUEUES_MAP), skills
├── theme.js               ← bascule thème clair/sombre (partagé entre pages)
├── package.json           ← "start": "node server.js" — aucune dépendance
├── .env.example           ← modèle de variables d'environnement
├── data/
│   └── shared_store.json  ← réglages superviseurs partagés (créé au runtime)
│
│  ── Pages secondaires (servies en statique par server.js, même session) ──
├── executif.html          ← /executif    (vue direction)
├── planning.html          ← /planning
├── pilotage.html          ← /pilotage
├── astreinte.html         ← /astreinte
├── couverture.html        ← /couverture
├── agents_jour.html       ← /agents-jour
├── notice.html            ← /notice (notice utilisateur)
└── design-test.html       ← /design-test (bac à sable UI)
```

**Le projet est volontairement « tout-en-un par fichier ».** `server.js` contient même le HTML
des pages d'admin/login/2FA (générées par `makeAdmin()`, `makeLogin()`, `makeCode()`).
`dashboard.html` contient son CSS et son JS inline. C'est assumé : pas de bundler, déploiement instantané.

---

## 4. Installation & déploiement (Railway)

### 4.1 En local

```bash
# 1. Cloner
git clone <repo> && cd wisecom-control-room

# 2. Créer le .env à partir du modèle
cp .env.example .env
#    puis renseigner les vraies valeurs (voir §4.3)

# 3. Lancer (Node ≥ 18 requis pour le fetch ICU/timezone)
node server.js
#    → http://localhost:3000
```

Aucun `npm install` n'est nécessaire (zéro dépendance). Le `package.json` ne déclare que le script `start`.

### 4.2 Production : Railway

Le projet est déployé sur **Railway**, qui sert la branche **`main`**.

> ⚠️ **POINT CRITIQUE DE WORKFLOW.** Railway déploie depuis `main`. Développer sur une branche de
> feature **ne suffit pas** à voir les changements en production : il faut **merger dans `main` et pousser**.
> Oublier cette étape = « je ne vois aucune amélioration » côté utilisateur.

Railway lance `npm start` (donc `node server.js`) et injecte le `PORT`. Le filesystem Railway est
**éphémère** : `data/shared_store.json` est **réinitialisé à chaque déploiement** sauf si un **volume
persistant** est monté et `DATA_DIR` pointé dessus (voir §11.3).

### 4.3 Variables d'environnement

| Variable | Rôle | Défaut (dev) |
|----------|------|--------------|
| `INO_LOGIN` | Login du compte de service INO | `tarik_dashboard` |
| `INO_PWD` | Mot de passe INO | *(fallback en dur — à remplacer)* |
| `INO_APIKEY` | Clé API INO (header `X-EKO-Api-Key`) | `dasboard_INO` |
| `SECURITY_CODE` | Code 2FA à 6 chiffres (post-login) | `286828` |
| `USERS` | Comptes superviseurs `login:mdp,login:mdp` | `tarik:…,admin:…` |
| `WEBHOOK_SECRET` | Secret du endpoint `/webhook` (vide = ouvert) | *(vide)* |
| `DATA_DIR` | Dossier de persistance du store partagé | `./data` |
| `PORT` | Port d'écoute | `3000` |

> 🔒 **Sécurité :** les fallbacks en dur dans `server.js` (lignes 5-9) sont des valeurs de **développement**.
> En production, **tout** doit venir des variables Railway. Ne jamais committer un vrai `.env`
> (il est dans `.gitignore`).

---

## 5. Authentification & sécurité

Triple barrière avant d'accéder au dashboard :

```
/login (login+mdp)  ──▶  /verify-code (2FA 6 chiffres)  ──▶  session cookie  ──▶  /
        │                        │                                  │
   USERS[login]===mdp     code===SECURITY_CODE              TTL glissant 10 min
```

| Mécanisme | Implémentation (`server.js`) | Détail |
|-----------|------------------------------|--------|
| **Comptes** | `USERS` parsé depuis l'env | `login` insensible à la casse |
| **2FA** | `SECURITY_CODE` (modifiable via `/admin`) | Étape `pending` (cookie 5 min) entre login et session |
| **Session** | `sessions{}` en mémoire, cookie `HttpOnly; SameSite=Strict` | **TTL glissant 10 min** d'inactivité (`getSession` repousse l'expiration) |
| **Rate-limit** | `isRL(ip)` / `recAttempt(ip)` | 5 tentatives / 15 min par IP |
| **En-têtes** | `secH(res)` | `X-Content-Type-Options:nosniff`, `X-Frame-Options:DENY` |
| **Rôles admin** | login `admin` ou `tarik` | requis pour toutes les routes `/api/admin/*` et la page `/admin` |

> ⚠️ Les sessions et la liste `USERS` sont **en mémoire** : un redéploiement déconnecte tout le monde,
> et un utilisateur créé via `/admin` n'existe que pour la session du process — pour le rendre permanent,
> l'ajouter à la variable d'env `USERS`.

**Page d'administration `/admin`** (réservée admin) : gestion utilisateurs, reset mot de passe,
changement du code 2FA, **calibration des horaires** (`/api/admin/apply-hours`), et **analyse des
files INO** (`/api/admin/queues`) qui détecte les files non mappées tombant dans le bucket « Autre ».

---

## 6. La source de données : l'API INO

**Hôte :** `https://wisecom.unicity.io/api`
**Authentification :** Bearer token obtenu via `GET /auth` (Basic auth login:mdp), valable ~4,5 min
(`bExp = Date.now()+270000`), mis en cache et renouvelé à la demande (`getToken(force)`).
**En-têtes envoyés à chaque appel :** `Authorization: Bearer <token>`, `X-EKO-Api-Key: <INO_APIKEY>`,
`Content-Type: application/json`.

### 6.1 Endpoints INO consommés

| Endpoint INO | Méthode | Usage dans le projet |
|--------------|---------|----------------------|
| `/auth` | GET (Basic) | Récupère le `access_token` |
| `/call/in/histories` | POST | **Source #1** : appels entrants du jour (`{startDate,endDate,limit:2000}`) |
| `/call/out/histories` | POST | **Source #2** : appels sortants du jour |
| `/agent/list` | GET | Compétences déclarées par agent (droits « larges » — `fetchAgentSkills`) |
| `/cc/agent/:id/flow/voice/skills/list` | POST | Compétences détaillées actif/inactif (droits `/cc/*` requis) |
| `/cc/agent/:id/flow/voice/skill/add` | POST | **Activer** une compétence (droits `/cc/*`) |
| `/flow/voice/routing` (+ replis) | GET/POST | Liste des files/routages déclarés (enrichit le mapping live) |

### 6.2 Les deux clients HTTP (`apiReq` vs `apiReqFull`)

Deux wrappers `https.request`, **tous deux avec timeout obligatoire** (`INO_TIMEOUT_MS = 15000`) :

| Fonction | Retour | Quand l'utiliser |
|----------|--------|------------------|
| `apiReq(method,p,body,token,timeoutMs)` | Le **corps JSON** directement. Sur timeout → `{_timeout:true, histories:[]}` | Routes qui n'ont pas besoin du status HTTP (la majorité) |
| `apiReqFull(method,p,body,token,timeoutMs)` | `{status, body}` (status HTTP exposé). Sur timeout → `{status:0, body:{_timeout:true}}` | Routes qui doivent gérer 401/429/5xx (compétences `/cc/*`, routing) |

```js
// Pattern timeout commun (extrait apiReq) — résout (jamais ne rejette) sur dépassement,
// pour accepter des données partielles plutôt que de bloquer tout l'appelant.
const ms = timeoutMs || INO_TIMEOUT_MS;
let settled = false;
const done = (fn,val)=>{ if(!settled){ settled=true; clearTimeout(timer); fn(val); } };
const timer = setTimeout(()=>{
  console.warn("[INO TIMEOUT] "+method+" "+p+" > "+ms+"ms");
  done(resolve, {_timeout:true, histories:[]});   // apiReqFull : {status:0,body:{_timeout:true}}
}, ms);
```

> 🛠️ **Leçon apprise (bug réel corrigé) :** `apiReqFull` n'avait **pas** de timeout. Un seul appel
> `/cc/*` qui ne répondait jamais gelait toute la boucle séquentielle de `/api/refresh-skills`.
> **Tout** appel sortant doit avoir un timeout. Ne jamais réintroduire un `https.request` nu.

### 6.3 Forme des données INO (`histories`)

Chaque ligne d'historique (`h`) exploitée a cette forme (champs réellement lus) :

```jsonc
{
  "callDate": "2026-06-17T08:12:34.000Z",   // ou "acdDate" — horodatage de l'appel
  "status":   "KO" | "Refus" | "Réitérant" | "Abandon" | "Transfert" | "RDV" | ...,  // qualification
  "call":  { "type": "OUTCALL" | ..., "agentDuration": 142 },  // durée de comm en secondes
  "agent": { "id": 123, "firstname": "Céline", "lastname": "Debaisieux", "username": "cdeb" },
  "queue": { "queueName": "Afnor_RQ_auditeur" }   // file → sert à détecter la campagne
}
```

Règles d'interprétation **critiques** (à connaître pour tout calcul) :
- Un appel **présenté** = toute ligne entrante.
- Un appel **décroché** = entrant avec `call.agentDuration > 0` **et** statut ≠ « abandon ».
- Un appel **abandonné** = entrant avec `status` contenant `"aband"` (l'appelant raccroche en file).
  **Un abandon n'a pas forcément d'agent** → il n'apparaît que dans les flux de file, jamais dans une ligne agent.
- Un appel **sortant** = ligne issue de `/call/out/histories`.
- `agentDuration` est la **durée de communication en secondes** (base de la DMC).

> ⚠️ L'API INO **ne fournit pas** : le statut temps réel d'un agent (en pause/dispo…), le « Hors SVI »,
> ni le détail post-appel (ACW). Tout cela est soit **estimé** (et signalé comme tel), soit `n.d.`.

### 6.4 Pagination (garde-fou anti-troncature)

`limit:2000` par requête. Si une réponse atteint exactement 2000 lignes, les données sont
probablement **tronquées** → le serveur **redécoupe la journée en 4 tranches de 6 h** et recompose
(voir `fetchAgentsDay` et `/api/queues-status`). Sans ce garde-fou, les stats des grosses journées
seraient fausses.

---

## 7. Routes du serveur (référence complète)

### 7.1 Routes publiques (sans session)

| Route | Méthode | Rôle |
|-------|---------|------|
| `/login` | GET/POST | Page + soumission login (→ rate-limit) |
| `/verify-code` | GET/POST | Page + soumission 2FA |
| `/logout` | GET | Détruit la session |
| `/favicon.ico`, `/favicon.svg` | GET | Favicon SVG inline |
| `/health` | GET | Santé : `{status, sseClients, inoConnected, uptime, stats}` |
| `/api/status` | GET | Statut léger (appels du jour, DMC) |
| `/api/config` | GET | **Renvoie `{CAMPS, QUEUES_MAP, SKILLS}`** (enrichi live depuis INO, cache 30 min) |
| `/webhook` | POST | Réception d'événements externes (rediffusés en SSE) — secret optionnel |

### 7.2 Routes authentifiées (session requise)

| Route | Méthode | Rôle |
|-------|---------|------|
| `/` ou `/dashboard` | GET | Sert `dashboard.html` |
| `/agents-day` | GET | **LA route principale** : agrégation agents+flux+slots (voir §9) |
| `/api/queues-status` | GET | Stats par file (QS, abandons, DMC) pour les cartes de files |
| `/events` | GET | Flux **SSE** (voyant de connexion) |
| `/api/store` | GET/POST | Lecture/écriture des réglages partagés (voir §11.3) |
| `/api/skills` | GET | Compétences via `/agent/list` (repli large) |
| `/api/refresh-skills` | POST | Compétences détaillées `/cc/*` par lots (voir §12) |
| `/api/skill-list/:id` | GET | Compétences brutes d'un agent |
| `/api/activate-skill` | POST | Active une compétence sur un agent (`/cc/*`) |
| `/api/qualif-list` | GET | Qualifications réelles agrégées par campagne |
| `/executif`, `/planning`, `/pilotage`, `/astreinte`, `/couverture`, `/agents-jour`, `/notice` | GET | Pages statiques secondaires |
| `/api/debug/flux-camps`, `/api/skills-debug/:id`, `/debug/raw-call` | GET | Endpoints de diagnostic |

### 7.3 Routes admin (login `admin`/`tarik` requis)

| Route | Méthode | Rôle |
|-------|---------|------|
| `/admin` | GET | Page d'administration |
| `/api/admin/stats` | GET | Stats système |
| `/api/admin/users` | GET/POST | CRUD utilisateurs (add/delete/reset) |
| `/api/admin/security-code` | POST | Change le code 2FA |
| `/api/admin/queues` | GET | Inventaire des files INO (7 j) + détection non-mappées, cache 10 min |
| `/api/admin/apply-hours` | POST | Applique `CAMP_HOURS_DEFAULT` dans le store partagé |

---

## 8. Configuration des campagnes & files

### 8.1 `queues_config.js` — la source unique

C'est **le** fichier à éditer pour ajouter un client ou une file. Il exporte trois structures :

```js
const CAMPS = ["Voltalis","ELECTROSUR","Vivest", /* … */ "Hyundai"];   // liste des campagnes
const QUEUES_MAP = {                                                    // file INO → campagne
  Afnor: ["Afnor","Afnor_RQ_auditeur","AFNOR Sortant", /* … */],
  // …
};
const SKILLS = ["LMDW","Equisign","Visio","Bilingue", /* … */];        // compétences connues
module.exports = { CAMPS, QUEUES_MAP, SKILLS };
```

Le **serveur** le charge via `require("./queues_config.js")`.
Le **client** le récupère via `GET /api/config` au démarrage (`boot()` dans `dashboard.html`),
**et** en garde une copie inline de secours si l'appel échoue.

> ✅ **Toujours modifier `queues_config.js`**, jamais la copie inline du dashboard : sinon serveur et
> client divergent et les QS par campagne deviennent fausses.

### 8.2 Détection de campagne (`detectCampaignSrv` / `campOfQueue`)

Une file est rattachée à une campagne par une **cascade** identique serveur/client :

1. **Match exact** dans `QUEUES_MAP`.
2. **Préfixe normalisé** (sans accents/espaces) : `"Afnor_RQ_…"` → `Afnor`.
3. **Inclusion** : le nom de campagne est contenu dans le nom de file.
4. **Premier token significatif** (après retrait de `"Sortant "`).

Une file non rattachée tombe dans **« Autre »** (côté flux) et ses appels ne comptent dans **aucune**
campagne → c'est exactement ce que `/api/admin/queues` aide à repérer.

### 8.3 Horaires d'ouverture (`CAMP_HOURS_DEFAULT` / `isCampOpenAt`)

Chaque campagne a des horaires d'ouverture (source : onglet *Horaire* du fichier INO du 10/06/2026),
structurés par jour FR (`lun…dim`). Les appels **hors horaires** sont **exclus des QS et des flux**
(comptés à part dans `horsHoraires`). `null` = **H24** (ex. Alcéane, Vivest).

```js
const CAMP_HOURS_DEFAULT = {
  Afnor:      _wkJR("09:00","17:00"),                 // Lun-Ven 9h-17h, fermé Sam/Dim
  ELECTROSUR: _wkJR("08:00","20:00"),
  Alcéane:    null,                                   // H24
  Voltalis:   _wkJR("08:00","20:00","10:00","18:00","10:00","18:00"),  // + samedi/dimanche
  // …
};
// _wkJR(o,f, sO,sF, dO,dF) : ouverture/fermeture Lun-Ven, puis Sam, puis Dim (null = fermé)
```

`isCampOpenAt(camp, date)` est la fonction autoritaire : `CAMP_HOURS_DEFAULT` prime, le store
superviseur (`criteres[camp].h24` / `.jours`) peut surcharger. L'heure est toujours évaluée en
**Europe/Paris** (cf. §9.0).

---

## 9. La méthode de calcul des indicateurs (le cœur)

> Cette section est la plus importante pour la passation. Chaque KPI est défini par sa **formule**,
> sa **source**, et le **fichier/fonction** où il est calculé.

### 9.0 Fuseau horaire — toujours Europe/Paris

Railway tourne en **UTC**. Toute heure métier (horaires d'ouverture, tranches 30 min, alertes GSM)
passe par des helpers Paris (`parisHour`, `parisMinOfDay`, `parisDateStr`, `parisJour` côté serveur ;
`_parisHourFmtTop` etc. côté client). **Ne jamais** utiliser `new Date().getHours()` directement
pour une logique métier.

### 9.1 Où chaque chose est calculée

```
SERVEUR (server.js → fetchAgentsDay/proc)              CLIENT (dashboard.html)
────────────────────────────────────────              ──────────────────────────────
• flux globaux (recus/decroches/abandons/sortants)     • renderKPIs(f)  → cartes KPI
• fluxCampagnes{camp:{decroches,abandons,…}}           • loadAgentsFromAPI → enrichit chaque agent
• par agent : appelsIn, dureeIn, dmt, presence, ACW    • computeOccupation → occupation par agent
• slots 30 min (vol/out/aband)                         • renderTable → tableau
                                                       • computeCmpSummary → tendance S-1…S-5
/api/queues-status → QS/abandon/DMC par file
```

### 9.2 Flux reçus / traités / manqués

**Source :** `/call/in/histories`. **Calcul serveur** dans `proc(h,"in")` :

| Indicateur | Définition | Code serveur |
|------------|------------|--------------|
| **Présentés** (`recusBrut`) | toute ligne entrante dans la plage horaire | `fluxRecusIn++` |
| **Décrochés** | entrant pris : a un agent ET non abandonné | `if(!aband && h.agent.id) fluxDecroches++` |
| **Abandons** | entrant dont `status` contient `"aband"` | `if(aband) fluxAbandons++` |
| **Reçus** (métier) | décrochés + abandons (= présentés *traitables*) | `flux.recus = fluxDecroches + fluxAbandons` |

Côté client (`renderKPIs`), pour le **périmètre complet ou filtre campagne**, on utilise les
**flux de file** (`_fluxCamps`, horaires d'ouverture appliqués). Avec un **filtre agent** actif,
on retombe sur les présentés/décrochés des agents sélectionnés (les abandons de file n'étant
pas attribuables à un agent).

```js
// dashboard.html — renderKPIs : reçus/traités/manqués
const totRecus    = _hasFlux ? _fx.recus      : totPres;                 // présentés
const entrTraites = _hasFlux ? _fx.decroches  : totDecr;                 // décrochés
const totManques  = _hasFlux ? _fx.abandons   : Math.max(0,totPres-totDecr);
```

### 9.3 QS — Qualité de Service ⭐

**La définition métier la plus importante.** C'est un **KPI de file, pas d'agent.**

> **QS = Appels traités / (Appels traités + Appels abandonnés) × 100**
> = décrochés / (décrochés + abandons), au niveau **file** — mêmes données que l'écran « RA » d'INO.

```js
// dashboard.html — renderKPIs
const qs = totRecus>0 ? Math.min(100, Math.round((entrTraites/totRecus)*100)) : 0;
```

- Les appels **hors horaires** d'ouverture sont **exclus** (et leur nombre affiché sous la valeur).
- Avec un **filtre agent** : repli sur `décrochés / présentés` des agents du périmètre.
- **Lecture :** ≥ 85 % bonne maîtrise · < 80 % attention.
- **Précision :** au niveau **file** (`/api/queues-status`), QS et taux d'abandon sont calculés à
  **2 décimales** pour coller à l'affichage natif INO :

```js
// server.js — /api/queues-status
qs:          q.recus>0 ? Math.round(q.decroches/q.recus*10000)/100 : 0,   // ex. 85.96
tauxAbandon: q.recus>0 ? Math.round(q.abandons/q.recus*10000)/100 : 0,
```

> 🛠️ **Leçon apprise :** des « incohérences » de QS rapportées venaient simplement d'un arrondi
> entier (`*100`) vs 2 décimales — **mêmes données**. Les cartes globales arrondissent à l'entier,
> les cartes par file gardent 2 décimales (= INO).

### 9.4 DMC & DMT

| KPI | Définition | Source |
|-----|------------|--------|
| **DMC** (Durée Moyenne de Communication) | temps de comm moyen des appels **entrants décrochés** | `agentDuration` |
| **DMT** (Durée Moyenne de Traitement) | DMC + post-appel (ACW) | DMC + ACW estimé |

**Subtilité de nommage à connaître :** côté serveur, le champ renvoyé `dmt` correspond en fait à la
**DMC des entrants décrochés** (`dureeIn/appelsIn`), et le client le re-mappe en `a.dmc`. Le DMC est
isolé sur les **entrants** uniquement (sinon le sortant gonflerait la moyenne).

```js
// server.js — par agent
duree:  a.duree,                                   // cumul IN+OUT (toutes comm)
dmt:    a.appelsIn>0 ? Math.round((a.dureeIn||0)/a.appelsIn) : 0,   // = DMC entrants décrochés

// dashboard.html — renderKPIs : moyenne pondérée par le volume
const totDuree = f.reduce((s,a)=> s + a.dmc*(a.decroches||0), 0);
const avgDmc   = totDecr>0 ? Math.round(totDuree/totDecr) : 0;
const avgAcw   = totDecr>0 ? Math.round(totAcwW/totDecr) : 0;
// DMT = avgDmc + avgAcw   (⚠ indicatif : l'ACW est une estimation)
```

### 9.5 ACW (post-appel) — **estimation**

INO n'expose pas le wrap-up. On l'**estime** : pour chaque agent, on trie ses appels et on mesure le
**trou entre la fin d'un appel et le début du suivant** (gaps > 1 h exclus comme « pauses »).

```js
// server.js — calcul ACW moyen par agent
const gaps=[];
for(let i=1;i<calls.length;i++){
  const gap=(calls[i].start-(calls[i-1].start+calls[i-1].dur))/1000;
  if(gap>0 && gap<3600) gaps.push(gap);            // exclure les pauses > 1h
}
if(gaps.length>0) agents[k].acwMoyen = Math.round(gaps.reduce((s,v)=>s+v,0)/gaps.length);
```

> ⚠️ À présenter **toujours** comme indicatif. Le DMT qui en dérive l'est aussi.

### 9.6 Présence & Heures de production

- **Présence** = amplitude entre la **1ʳᵉ et la dernière action** de l'agent, calculée **jour par jour**
  puis sommée (sur une plage multi-jours, sinon l'écart lundi→dimanche écraserait tout). Champ serveur :
  `presenceSec = Σ (max-min) par jour`.
- **H. Prod** (client) = présence en heures ; **repli** si mono-appel (présence = 0) :
  `comm / 0.75` (estimation ~75 % d'occupation).

```js
// dashboard.html — loadAgentsFromAPI
let hprod=0;
if(a.premiereAction && a.derniereAction){
  const presH=(new Date(a.derniereAction)-new Date(a.premiereAction))/3600000;
  if(presH>0) hprod=+presH.toFixed(2);
}
if(hprod===0 && a.duree>0) hprod=+(a.duree/3600/0.75).toFixed(2);   // repli mono-appel
```

### 9.7 Taux d'occupation (paramétrable par campagne)

> **Occupation = (Temps de comm [+ ACW si activé]) / (Présence × min_productives/h ÷ 60)**

Le diviseur `min_productives/h` (défaut **50** → tolère 10 min/h de pause/wrap ; mettre **60** =
présence brute) **et** l'inclusion de l'ACW sont **réglables PAR CAMPAGNE** (⚙ Critères & KPI),
car la définition d'occupation varie selon le client.

```js
// dashboard.html — computeOccupation : retourne null si non mesurable (mode honnête)
function computeOccupation(camp, commSec, presSec, acwSec){
  if(!(presSec>0)) return null;
  var p = occCampParams(camp);                       // {minH:50, incAcw:false} par défaut
  var num = (commSec||0) + (p.incAcw ? (acwSec||0) : 0);
  if(!(num>0)) return null;
  var basis = presSec * (p.minH/60);
  if(!(basis>0)) return null;
  return Math.min(100, Math.round((num/basis)*100));
}
```

> 🛠️ **Garde-fou « mode honnête » :** si la présence mesurée < temps de comm (incohérent),
> `presenceSec` est forcé à 0 et l'occupation devient `n.d.` — on n'invente pas une occupation
> constante ~96 % comme le faisait un ancien repli.

### 9.8 % Réalisé

> **% Réalisé = Σ Actes réalisés / Σ Objectifs des agents du périmètre × 100** (plafonné à 100)

- **Acte** = appel décroché + appel sortant + mail saisi.
- **Objectif** d'un agent = « Objectif d'appels » de sa campagne (⚙ Critères & KPI, **défaut 50**).
- En lecture file, les actes incluent les appels pris par des **agents mutualisés** d'autres campagnes.

```js
// dashboard.html — renderKPIs
const totObj    = f.reduce((s,a)=> s+(a.obj||50), 0) || 1;
const actesReal = _hasFlux ? ((_fx.decroches||0)+(_fx.sortants||0)+totM) : totActes;
const pct       = Math.min(100, Math.round((actesReal/totObj)*100));
```

> ⚠️ Si les objectifs réels par campagne ne sont pas saisis, le défaut 50 fausse ce KPI.

### 9.9 Actes/h, App. sortants/h

```js
const totActes = totDecr + totSort + totM;          // décrochés + sortants + mails
const totHP    = f.reduce((s,a)=> s+a.hprod, 0) || 1;
const actesH   = +(totActes/totHP).toFixed(1);       // productivité horaire globale
const appelsH  = +(totSort/totHP).toFixed(1);        // cadence sortants/h
```

### 9.10 Autres compteurs (qualifications réelles INO)

`tagQualif(agent, status)` parcourt `h.status` brut et incrémente : `ko` (statut contient « ko »/« hors svi »),
`refus`, `reiterants`, `transferts`, `transfo_yes` (rdv/intéressé). Le **« 100 % KO »** des KPI =
présentés **non décrochés** (`nonDecroches`, `agentDuration=0`), à ne pas confondre avec les abandons
de file (l'agent n'a jamais sonné). **Hors SVI** et **statut temps réel** = `n.d.` (non exposés par INO).

### 9.11 Tendance vs S-1…S-5

`computeCmpSummary()` compare la période affichée aux **mêmes jours, 1 à 5 semaines plus tôt**
(décalage de 7×N jours, mêmes données INO réelles, **filtrées sur le même périmètre campagnes**).
On ne compare **que des faits bruts** (flux, QS, DMC, actes/h) — **jamais** le « % Réalisé »
(qui dépend d'objectifs configurés *aujourd'hui*, donc non comparable). Cache en `cmpRefCache`
(le passé est immuable, jamais invalidé).

---

## 10. L'affichage côté client

`dashboard.html` est une SPA. La fonction `render()` orchestre tout :

```js
function render(){
  const filtered = getFiltered();        // applique tous les filtres (§11)
  const sorted   = getSorted(filtered);  // tri courant
  renderKPIs(filtered);                  // cartes du haut
  renderTable(sorted);                   // tableau agents
  renderChart();                         // graphique tranches 30 min
  renderAlerts(filtered);                // onglet alertes
  renderSkills();                        // matrice compétences
  renderWA();                            // export WhatsApp
  // + badges, résumé de sélection, occupations recalculées…
}
```

### 10.1 Onglets

| Onglet | `id` | Contenu |
|--------|------|---------|
| **Agents** | `tab-tableau` | KPI + tableau agent par agent (colonnes configurables) |
| **Volumes & Tranches** | `tab-graphiques` | Graphique de volume par créneau de 30 min |
| **Matrice compétences** | `tab-skills` | Couverture agent × compétence |
| **Export WhatsApp** | `tab-whatsapp` | Synthèse formatée copiable / exportable |
| **Alertes** | `tab-alertes` | Staffing, astreinte, GSM (badge compteur) |

### 10.2 Cartes KPI

Construites dans `renderKPIs(f)` à partir d'un tableau `kpis[]` (label, valeur, sous-titre, seuils
`alert`/`good`, jauge, infobulle de définition `def`, et delta de tendance `cmp`). Chaque carte a une
**infobulle ⓘ** qui explique la formule à l'utilisateur final — **garder ces définitions à jour**
si une formule change. Classes visuelles : `.alert` (rose), `.good` (vert), `.hero`, `.priority`.

### 10.3 Tableau agents

`renderTable(sorted)` + colonnes définies dans `COL_DEFS` (clé, libellé, visible par défaut).
Le panneau « Colonnes » (`buildColPanel`) permet d'afficher/masquer chaque colonne ; la sélection est
locale (`visibleCols`). Colonnes clés : Statut, File/Campagne, 1ʳᵉ connexion, H. prod, Appels présentés,
Décrochés, Refusés, Sortants, Mails, Actes, Actes/h, DMC, DMT, Occupation, % Réalisé, Activité du jour
(sparkline SVG), Compétences. Une ligne se déplie (`toggleRow`) pour le détail par file (`detailRowHTML`).

### 10.4 Graphique de tranches

`renderChart()` dessine en **SVG inline** (pas de lib externe) le volume par créneau de 30 min,
filtré sur les campagnes sélectionnées via `slot.queues`. Sur une plage multi-jours, le serveur renvoie
une **moyenne par jour** par tranche (sinon le cumul écrase l'échelle).

---

## 11. Filtres, vues sauvegardées & persistance

### 11.1 Les filtres (variables globales)

```js
let selCamps  = [...CAMPS];        // campagnes sélectionnées
let selQueues = [];                // files sélectionnées
let selAgents = […];               // noms d'agents sélectionnés
let selSkills = [...SKILLS];       // compétences sélectionnées
let selStatus = [...STATUSES];     // statuts sélectionnés
```

`getFiltered()` applique la cascade. Point subtil : **principe « 1 agent = N compétences »** — avec un
filtre campagne, un agent dont la campagne *primaire* n'est pas sélectionnée est **quand même inclus**
s'il **couvre** une campagne sélectionnée via ses compétences/files (`waAgentCovers`). Cela gère les
campagnes « flux-only » (ex. M123) entièrement traitées par des agents mutualisés.

### 11.2 Vues sauvegardées (presets)

`savePreset()` / `applyPreset(name)` stockent `{camps,queues,agents,skills,status}` dans `localStorage`
(`wisecom_control_room_presets_v1`) **et** poussent vers le store partagé (`pushStore('presets',…)`).

> 🛠️ **Bug réel corrigé (à comprendre absolument).** `applyPreset` confronte les agents sauvegardés au
> roster du jour. Or **le roster du jour ne contient que les agents ayant déjà pris un appel** (§1).
> Tôt le matin, la plupart des agents d'une vue ne sont pas encore dedans → l'ancien code réduisait
> `selAgents` à la poignée reconnue, **vidant le tableau** alors que les KPI (basés sur les flux)
> restaient pleins. Correctif : si le taux de correspondance est **< 50 %**, on retombe sur **tout le
> roster du jour** et on **avertit** l'utilisateur.

```js
// dashboard.html — applyPreset (extrait du correctif)
const _todayAgents = new Set(agents.map(a=>a.nom));
const _savedAgents = Array.isArray(p.agents) ? p.agents : (agents.length?agents.map(a=>a.nom):AGENTS_BASE.map(a=>a.nom));
const _filtered    = _savedAgents.filter(n=>_todayAgents.has(n));
const _matchRatio  = _savedAgents.length>0 ? _filtered.length/_savedAgents.length : 1;
const _lowMatch    = _filtered.length>0 && _matchRatio<0.5;
selAgents = (_filtered.length>0 && !_lowMatch) ? _filtered
                                               : (agents.length?agents.map(a=>a.nom):_savedAgents);
// si _lowMatch → presetStatus(...) en orange pour signaler le repli sur tout le roster
```

### 11.3 Persistance partagée (`/api/store` + `shared_store.json`)

Les réglages **communs à tous les superviseurs** (seuils, backlog, ajustements mails/heures, colonnes
WhatsApp, presets, planning…) sont stockés dans **un fichier JSON serveur** (`data/shared_store.json`)
plutôt que dans le `localStorage` de chaque poste (qui causait des incohérences d'un navigateur à l'autre).

- `pullStore()` (client) récupère l'état au chargement ; `pushStore(key,value)` écrit.
- Clés autorisées : `STORE_KEYS = ["criteres","backlog","mailsEdit","waCols","presets","astreintes","planning","poles","mailOverrides","pilotageTpl","radarTpl","planningHist"]`.
- Écriture serveur **différée + atomique** (`tmp` puis `rename`) pour ne pas corrompre le fichier.

> ⚠️ **Persistance & Railway :** sans volume monté, le fichier est **réinitialisé à chaque déploiement**.
> Pour le conserver : monter un volume Railway et fixer `DATA_DIR` sur son point de montage.

---

## 12. Compétences agents (le module le plus fragile)

C'est historiquement la partie la plus instable, car elle dépend des **droits `/cc/*`** du compte INO.

**Deux sources, par ordre de richesse :**

1. **`/agent/list`** (`fetchAgentSkills`) — compétences **déclarées**, droits larges, **toujours
   disponibles**, mis en cache 1×/jour. Livrées automatiquement avec le payload `/agents-day`.
2. **`/cc/agent/:id/flow/voice/skills/list`** (`/api/refresh-skills`) — compétences **détaillées**
   (actif/inactif, score), nécessite les droits **Centre de Contacts** `/cc/*`. Déclenché par le
   bouton ↺ Compétences ou automatiquement en arrière-plan.

**Robustesse de `/api/refresh-skills` (serveur)** — traitement **par lots de 3** agents, avec :

- **Renouvellement de token** sur `401` (1ʳᵉ tentative), puis abandon « droits insuffisants ».
- **Retry avec backoff** sur timeout (`status:0`), `429`, `5xx` (jusqu'à 2 tentatives de plus).
- **Budget temps global de 50 s** : au-delà, on arrête d'ouvrir des lots et on renvoie un résultat
  **partiel exploitable** (les agents restants sont marqués `"Budget temps dépassé — relancez…"`)
  plutôt que de risquer un kill infra sans réponse.
- **Extraction tolérante** de la forme de réponse INO (varie selon version :
  `{flowSkills}` / `{profileSkills}` / `{skills}` / `{data}` / tableau direct).

**Robustesse côté client (`refreshSkills`)** :

- **Timeout réseau** via `AbortController` (70 s, marge au-dessus du budget serveur de 50 s).
- **Relances automatiques multi-rounds** (jusqu'à 4) : ne re-demande **que** les agents marqués
  « budget dépassé », pour compléter un gros effectif sans clic manuel répété.
- **Repli** sur `/api/skills` (`/agent/list`) si zéro agent n'a obtenu de compétences détaillées.

```js
// dashboard.html — refreshSkills : relance ciblée sur le reliquat
let results={}, pending=agentIds.slice();
for(let round=0; round<4 && pending.length>0; round++){
  const batchResults = await fetchSkillsBatch(pending);   // POST /api/refresh-skills (AbortController 70s)
  Object.assign(results, batchResults);
  pending = pending.filter(id=>{
    const r=results[id];
    return r && r.error && String(r.error).startsWith('Budget temps dépassé');
  });
}
```

> Le message UI « ⚠ Compétences indisponibles · réessayer » (dans `buildAllDropdowns`) est piloté par
> `window._skillsLoadFailed`. Si les droits `/cc/*` manquent côté compte INO, c'est **attendu** :
> le dashboard retombe sur les compétences déclarées et le diagnostic indique « Droits insuffisants ».

---

## 13. Robustesse & « mode honnête »

Récapitulatif des garde-fous à **préserver** dans toute évolution :

| Garde-fou | Où | Pourquoi |
|-----------|-----|----------|
| Timeout sur **tout** appel INO (15 s) | `apiReq`/`apiReqFull` | Un appel pendu ne doit jamais geler une boucle |
| `joursEchec[]` distinct de « 0 appel » | `fetchAgentsDay` | Un échec réseau ≠ une journée sans appel ; signalé à l'écran |
| Pagination par tranches de 6 h si limit 2000 atteinte | `fetchAgentsDay`, `/api/queues-status` | Évite des stats tronquées |
| Budget temps 50 s + résultat partiel | `/api/refresh-skills` | Toujours répondre un JSON propre |
| Occupation `null` si présence non mesurable | `computeOccupation` | Ne pas inventer ~96 % |
| `n.d.` pour les données non exposées par INO | KPI Hors SVI, statut RT | Pas d'estimation trompeuse |
| Repli `applyPreset` si match < 50 % | `applyPreset` | Ne pas vider le tableau silencieusement |
| 200 + `error:` plutôt que 500 muet | `/agents-day` | Le client distingue « pas de données » de « échec » |
| Retry réseau (push/fetch) avec backoff exponentiel | scripts git / fetch | Tolérance aux coupures |

---

## 14. Exports (PDF / Excel / CSV)

Tous les exports sont **générés côté client, sans dépendance** :

| Fonction | Format | Onglet/objet |
|----------|--------|--------------|
| `exportPDF()` | PDF (fenêtre `window.print()` sur un HTML dédié) | Tableau agents |
| `exportXlsx()` | Excel (XML SpreadsheetML / HTML table) | Tableau agents |
| `exportSkillsPDF()` | PDF | Matrice compétences |
| `exportQualifCsv/Excel/PDF()` | CSV/Excel/PDF | Qualifications |
| `exportQueueExcel/PDF()` | Excel/PDF | Statut des files |
| `exportQueueAgentsXlsx/PDF()` | Excel/PDF | Agents d'une file |
| `exportWA_PDF/Excel()` | PDF/Excel | Synthèse WhatsApp |

Le PDF passe par une **fenêtre d'impression** : un HTML autonome est généré avec
`<script>window.onload=()=>window.print()</script>`. Les exports Excel s'appuient sur des tables HTML
interprétées par Excel — pas de binaire `.xlsx` réel, mais ouvrable partout.

---

## 15. Recettes de maintenance courantes

### Ajouter une campagne / une file
1. Éditer **`queues_config.js`** : ajouter le nom dans `CAMPS` et le mapping dans `QUEUES_MAP`.
2. (Optionnel) ajouter ses horaires dans `CAMP_HOURS_DEFAULT` (`server.js`) puis lancer
   **/admin → Appliquer les horaires calibrés**.
3. Vérifier via **/admin → Analyser les files INO** qu'aucune file ne tombe en « non mappée ».
4. Commit → merge `main` → push (Railway redéploie).

### Changer un seuil/objectif de KPI
- Par campagne : **⚙ Critères & KPI** dans l'UI (stocké dans le store partagé, pas de déploiement).
- Seuils d'alerte globaux (couleurs des cartes) : en dur dans `renderKPIs` (`alert:`/`good:`).

### Ajouter un utilisateur superviseur (permanent)
- Ajouter `login:motdepasse` à la variable d'env **`USERS`** sur Railway (pas via /admin, qui est volatil).

### Modifier le code 2FA
- **/admin → Code de sécurité 2FA** (immédiat, en mémoire), **ou** variable `SECURITY_CODE` (permanent).

### Workflow git (rappel impératif)
```bash
# développer sur la branche de feature, PUIS merger dans main (Railway sert main)
git checkout <feature-branch> && git commit -am "…" && git push -u origin <feature-branch>
git checkout main && git merge <feature-branch> --no-edit && git push -u origin main
```

---

## 16. Dépannage / FAQ

**« Le tableau agents est vide mais les KPI affichent des chiffres. »**
→ Normal : KPI = flux de file (serveur), tableau = agents filtrés. Cause la plus fréquente : une **vue
sauvegardée** appliquée tôt le matin (peu d'agents ont déjà appelé) — voir le correctif §11.2. Vérifier
aussi les filtres AGENTS/CAMPAGNES/STATUT.

**« Un agent connecté n'apparaît pas. »**
→ Il n'a **aucun appel** sur la fenêtre horaire choisie. Le roster est construit depuis les appels (§1).

**« Compétences indisponibles · réessayer. »**
→ Droits `/cc/*` manquants sur le compte INO, ou INO lent. Le dashboard retombe sur les compétences
déclarées (`/agent/list`). Diagnostic : `GET /api/skills-debug/:agentId`.

**« Les QS diffèrent entre deux écrans. »**
→ Arrondi entier (cartes globales) vs 2 décimales (cartes par file = INO). Mêmes données (§9.3).

**« Une journée passée affiche 0 appel. »**
→ Distinguer « vraiment 0 » d'un **échec INO** : regarder le toast `joursEchec` et réessayer. Vérifier
aussi que le token n'a pas expiré (renouvelé automatiquement avant chaque `/agents-day`).

**« Mes réglages ont disparu après un déploiement. »**
→ `shared_store.json` réinitialisé (filesystem Railway éphémère). Monter un volume + `DATA_DIR` (§11.3).

**Endpoints de diagnostic utiles :**
`/health` · `/api/status` · `/api/debug/flux-camps` · `/api/skills-debug/:id` · `/debug/raw-call`
· `/admin` (Analyser les files INO).

---

## 17. Glossaire métier

| Terme | Définition |
|-------|------------|
| **Campagne** | Un client du centre d'appels (Afnor, Voltalis…), regroupant une ou plusieurs files. |
| **File (queue)** | File d'attente INO. Une campagne = N files. Nom dans `h.queue.queueName`. |
| **Présenté** | Appel entrant routé (proposé) — qu'il soit décroché ou non. |
| **Décroché / Traité** | Appel entrant pris par un agent (`agentDuration>0`, non abandonné). |
| **Abandon** | Appel entrant où l'appelant raccroche avant mise en relation (pas d'agent). |
| **QS** | Qualité de Service = traités / (traités + abandons), au niveau file. |
| **DMC** | Durée Moyenne de Communication (entrants décrochés). |
| **DMT** | Durée Moyenne de Traitement = DMC + ACW (post-appel, estimé). |
| **ACW** | After-Call Work / wrap-up — temps post-appel (ici **estimé** par les gaps). |
| **Acte** | Unité de production = 1 appel décroché OU 1 sortant OU 1 mail saisi. |
| **Occupation** | Part du temps de présence en communication (paramétrable par campagne). |
| **H. Prod** | Heures de production = amplitude de présence (1ʳᵉ→dernière action). |
| **Mutualisé** | Agent traitant les appels de plusieurs campagnes (principe 1 agent = N compétences). |
| **Mode honnête** | Règle projet : afficher `n.d.`/signaler un échec plutôt qu'inventer une valeur. |
| **RA** | Réception d'Appels — l'écran INO de référence pour la QS. |

---

*Fin du guide. Pour toute formule, la référence fait foi dans `server.js` (agrégations) et
`dashboard.html` → `renderKPIs` / `computeOccupation` / `loadAgentsFromAPI` (présentation).*
