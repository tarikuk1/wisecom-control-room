<#
  evo_push.ps1 — Envoie les données « appels sortants » d'Evolution vers le tableau de bord.

  À QUOI ÇA SERT
  Le serveur Evolution (evo1.ekiom.net) n'est joignable que depuis le réseau du bureau.
  Le tableau de bord (sur Railway, dans le cloud) ne peut donc pas aller chercher les
  données lui-même. Ce script fait l'inverse : il tourne sur un poste du bureau, va
  chercher les chiffres sur Evolution (ça marche, on est sur le même réseau), puis les
  envoie au tableau de bord par Internet (ça marche aussi, une connexion sortante n'est
  presque jamais bloquée par un pare-feu de bureau).

  INSTALLATION (une seule fois)
  1) Modifier les 4 valeurs dans le bloc « À CONFIGURER » ci-dessous.
  2) Ouvrir le Planificateur de tâches Windows :
     - Créer une tâche de base
     - Déclencheur : répéter toutes les 1 minute, indéfiniment
     - Action : démarrer un programme
         Programme : powershell.exe
         Arguments : -ExecutionPolicy Bypass -File "C:\chemin\vers\evo_push.ps1"
     - Cocher « Exécuter même si l'utilisateur n'est pas connecté »
  3) Lancer la tâche une première fois manuellement pour vérifier que tout fonctionne
     (un message « Envoi OK » doit s'afficher, ou apparaître dans le journal evo_push.log).
#>

# ── À CONFIGURER ────────────────────────────────────────────────────────────
$EvoHost      = "evo1.ekiom.net"                 # serveur Evolution
$EvoLogin     = "NCADMIN"                        # identifiant Manager Evolution
$EvoPwd       = "NCADMIN"                        # mot de passe Manager Evolution
$DashboardUrl = "https://VOTRE-APP.up.railway.app/api/evo/ingest"  # ⚠️ à remplacer par l'URL réelle du tableau de bord
$PushSecret   = "CHANGE_ME_evo_push"             # doit être identique à EVO_PUSH_SECRET sur Railway
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$LogFile = Join-Path $PSScriptRoot "evo_push.log"

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

try {
    $pair = "$($EvoLogin):$($EvoPwd)"
    $basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
    $headers = @{ Authorization = "Basic $basicAuth"; Accept = "application/json" }

    $campaignsUrl = "https://$EvoHost/manager/api/v1/measurable/campaigns?format=json"
    $agentsUrl    = "https://$EvoHost/manager/api/v1/measurable/agents?format=json"

    $campaigns = Invoke-RestMethod -Uri $campaignsUrl -Headers $headers -Method Get -TimeoutSec 15
    $agents    = Invoke-RestMethod -Uri $agentsUrl    -Headers $headers -Method Get -TimeoutSec 15

    $body = @{ campaigns = $campaigns; agents = $agents } | ConvertTo-Json -Depth 10 -Compress

    $pushHeaders = @{ "X-Evo-Push-Secret" = $PushSecret; "Content-Type" = "application/json" }
    $resp = Invoke-RestMethod -Uri $DashboardUrl -Headers $pushHeaders -Method Post -Body $body -TimeoutSec 15

    if ($resp.ok) {
        Write-Log "Envoi OK (reçu par le tableau de bord à $($resp.receivedAt))"
    } else {
        Write-Log "Envoi refusé par le tableau de bord : $($resp.error)"
    }
} catch {
    Write-Log "ERREUR : $($_.Exception.Message)"
}
