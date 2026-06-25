# Déploiement evo_push.ps1 sur le serveur Evolution

## Pourquoi (le problème à régler)
Le tableau de bord Control Room affiche les compteurs **REST** (appels, accords, CU…) mais
**tous les indicateurs SQL sont vides (n.d.)** : durées (DMC/DMT/attente), heures de
production, ratios /heure, et le détail **production par agent**.

**Cause** : le script `evo_push.ps1` interroge la base SQL `EVOLUTIONDB`
(`45.129.110.3`, port **1433**). Depuis le réseau **bureau**, ce port est **bloqué**
(le serveur n'accepte 1433 que depuis l'intérieur de son datacenter — vérifié : l'hôte
répond en 80/443 mais 1433/3389/445 sont filtrés). Résultat : le bloc SQL échoue
silencieusement et le dashboard n'a que le REST.

## La solution retenue
Faire tourner `evo_push.ps1` **directement sur le serveur Evolution** au lieu d'un poste
bureau. De là, le SQL est sur le LAN interne et **1433 est joignable**.

Topologie :
- Evolution / Manager (REST) : `evo1.ekiom.net` = **45.129.110.2**
- Base SQL `EVOLUTIONDB` : **45.129.110.3** (même sous-réseau → joignable en interne)
- Tableau de bord : `https://control-room-production-a320.up.railway.app` (Railway, sortie 443)

Le script garde `Server=45.129.110.3` : depuis 45.129.110.2 c'est une connexion LAN, elle
passe. (Option : remplacer par `localhost` si la base tourne sur la même machine .2.)

## Procédure (à exécuter sur le serveur 45.129.110.2)
1. Copier `evo_push.ps1` sur le serveur, ex. `C:\evo\evo_push.ps1`.
2. **Test manuel** (PowerShell sur le serveur) :
   ```
   powershell -ExecutionPolicy Bypass -File "C:\evo\evo_push.ps1"
   ```
   Vérifier le journal `C:\evo\evo_push.log` : on doit voir
   `SQL OK : N lignes stats, M campagnes fichier, K lignes agent x campagne`
   puis `Envoi OK`. (Si `AVERTISSEMENT SQL`, la base n'est pas joignable depuis ce
   serveur → vérifier que 45.129.110.3:1433 répond en local.)
3. **Planificateur de tâches** :
   - Créer une tâche de base — déclencheur : répéter **toutes les 1 minute**, indéfiniment.
   - Action : `powershell.exe`
     arguments `-ExecutionPolicy Bypass -File "C:\evo\evo_push.ps1"`.
   - Cocher « Exécuter même si l'utilisateur n'est pas connecté » + « Exécuter avec les
     autorisations maximales ».
4. Attendre 1-2 min, recharger le dashboard : durées, /h et **production par agent**
   doivent se remplir. Le bandeau rouge « SQL indisponible » disparaît.

## Identifiants (déjà dans le script)
- Manager Evolution : `NCADMIN` / `NCADMIN`
- SQL : `sa` / (mot de passe dans le script)
- Secret push Railway : `286828`
Aucune autre configuration nécessaire.

## À transmettre à Ekiom (admin du serveur)
> Pouvez-vous installer un petit script PowerShell en lecture seule sur le serveur
> Evolution (45.129.110.2), planifié toutes les minutes ? Il lit l'API Manager + la base
> EVOLUTIONDB (45.129.110.3:1433, en lecture seule, NOLOCK) et envoie un JSON au tableau
> de bord. On le met sur le serveur car 1433 est filtré depuis le bureau. Script + notice
> fournis. Alternative si vous préférez : ouvrir 1433 entrant depuis notre IP bureau.
