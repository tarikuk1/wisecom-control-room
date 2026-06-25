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
$DashboardUrl = "https://control-room-production-a320.up.railway.app/api/evo/ingest"
$PushSecret   = "286828"                         # doit être identique à EVO_PUSH_SECRET sur Railway
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$LogFile = Join-Path $PSScriptRoot "evo_push.log"

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $basicAuth"; Accept = "application/json" }

$campaignsUrl = "https://$EvoHost/manager/api/v1/measurable/campaigns?format=json"
$agentsUrl    = "https://$EvoHost/manager/api/v1/measurable/agents?format=json"

try {
    $campaigns = Invoke-RestMethod -Uri $campaignsUrl -Headers $headers -Method Get -TimeoutSec 15
    $agents    = Invoke-RestMethod -Uri $agentsUrl    -Headers $headers -Method Get -TimeoutSec 15
} catch {
    Write-Log "ERREUR (côté Evolution, identifiants EvoLogin/EvoPwd ou réseau) : $($_.Exception.Message)"
    exit 1
}

# Rapport « Estado de listas » (état du fichier par campagne). Optionnel : si ça
# échoue, on continue quand même l'envoi des données principales.
$estado = $null
try {
    $estadoUrl  = "https://$EvoHost/manager/api/v1/admin/reports/100000035/invoke?format=json"
    $estadoHead = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }
    $estado = Invoke-RestMethod -Uri $estadoUrl -Headers $estadoHead -Method Post -Body '{"Parameters":[]}' -TimeoutSec 20
} catch {
    Write-Log "AVERTISSEMENT : rapport Estado de listas indisponible ($($_.Exception.Message)) - envoi sans l'etat du fichier."
}

# --- Requete SQL EVOLUTIONDB (LECTURE SEULE) ---
$sqlStats = $null
$sqlFiles = $null
$sqlAgentCamps = $null
$sqlDiag = $null
try {
    $cs = "Server=45.129.110.3;Database=EVOLUTIONDB;User Id=sa;Password=Kj41mg65e!;Encrypt=False;TrustServerCertificate=True;Connect Timeout=12"
    $sc = New-Object System.Data.SqlClient.SqlConnection $cs
    $sc.Open()
    $cmdIso = $sc.CreateCommand()
    $cmdIso.CommandText = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;"
    $cmdIso.ExecuteNonQuery() | Out-Null

    # Stats par campagne + code de resolution
    $q1 = @"
SELECT
    t.idCampanya,
    c.NOMBRE        AS campNom,
    t.idFinal,
    ISNULL(f.DESCRIPCION,'')        AS finalNom,
    ISNULL(f.CONTACTADO, 0)         AS contactado,
    ISNULL(f.CLASEFINAL, 2)         AS claseFinal,
    COUNT(*)                        AS nb,
    AVG(CASE WHEN ISNULL(f.CONTACTADO,0) > 0 AND t.tInicio IS NOT NULL AND t.tFinal IS NOT NULL
             THEN CAST(DATEDIFF(second, t.tInicio, t.tFinal) AS float)
             ELSE NULL END)         AS dmc_sec,
    AVG(CASE WHEN t.nTAdmin > 0 THEN CAST(t.nTAdmin AS float) ELSE NULL END) AS dmt_sec,
    AVG(CASE WHEN t.nTQ    > 0 THEN CAST(t.nTQ    AS float) ELSE NULL END) AS attente_sec,
    SUM(CASE WHEN t.tInicio IS NOT NULL AND t.tFinal IS NOT NULL
             THEN DATEDIFF(second, t.tInicio, t.tFinal) ELSE 0 END) AS sum_call_sec,
    SUM(ISNULL(CAST(t.nTAdmin AS bigint), 0))                       AS sum_wrapup_sec
FROM TRANSACCION t WITH (NOLOCK)
LEFT JOIN CAMPANYA c WITH (NOLOCK) ON c.IDCAMPANYA = t.idCampanya
LEFT JOIN FINALES  f WITH (NOLOCK) ON f.IDCAMPANYA = t.idCampanya AND f.IDFINAL = t.idFinal
WHERE t.tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
  AND t.tInicio <  DATEADD(day,1,CAST(CAST(GETDATE() AS date) AS datetime))
  AND t.nOrigenTransaccion IN (4,5)
  AND t.Estado = 1
GROUP BY t.idCampanya, c.NOMBRE, t.idFinal, f.DESCRIPCION, f.CONTACTADO, f.CLASEFINAL
ORDER BY t.idCampanya, COUNT(*) DESC
"@
    $cmd1 = $sc.CreateCommand(); $cmd1.CommandText = $q1; $cmd1.CommandTimeout = 30
    $da1 = New-Object System.Data.SqlClient.SqlDataAdapter $cmd1
    $dt1 = New-Object System.Data.DataTable; $da1.Fill($dt1) | Out-Null
    $rows1 = @()
    foreach ($r in $dt1.Rows) {
        $dmc = if ($r["dmc_sec"] -is [System.DBNull]) { $null } else { [double]$r["dmc_sec"] }
        $dmt = if ($r["dmt_sec"] -is [System.DBNull]) { $null } else { [double]$r["dmt_sec"] }
        $att = if ($r["attente_sec"] -is [System.DBNull]) { $null } else { [double]$r["attente_sec"] }
        $cSec = if ($r["sum_call_sec"]   -is [System.DBNull]) { 0 } else { [long]$r["sum_call_sec"] }
        $wSec = if ($r["sum_wrapup_sec"] -is [System.DBNull]) { 0 } else { [long]$r["sum_wrapup_sec"] }
        $rows1 += @{
            idCampanya    = [string]$r["idCampanya"]
            campNom       = [string]$r["campNom"]
            idFinal       = [string]$r["idFinal"]
            finalNom      = [string]$r["finalNom"]
            contactado    = [int]$r["contactado"]
            claseFinal    = [int]$r["claseFinal"]
            nb            = [int]$r["nb"]
            dmc_sec       = $dmc
            dmt_sec       = $dmt
            attente_sec   = $att
            sum_call_sec  = $cSec
            sum_wrapup_sec= $wSec
        }
    }
    $sqlStats = $rows1

    # Etat des fichiers par campagne
    $q2 = @"
SELECT
    isc.IDCAMPANYA,
    COUNT(*)                                                     AS total,
    SUM(CASE WHEN isc.nEstado = 0   THEN 1 ELSE 0 END)           AS disponibles,
    SUM(CASE WHEN isc.nEstado = 300 THEN 1 ELSE 0 END)           AS terminees,
    AVG(CAST(isc.NUMINTENTOSCONTACTOREALIZADOS AS float))         AS moy_tentatives
FROM tbIdentidadSujetoCampanya isc WITH (NOLOCK)
WHERE isc.IDCAMPANYA IN (
    SELECT DISTINCT idCampanya FROM TRANSACCION WITH (NOLOCK)
    WHERE tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
      AND nOrigenTransaccion IN (4,5)
)
GROUP BY isc.IDCAMPANYA
"@
    $cmd2 = $sc.CreateCommand(); $cmd2.CommandText = $q2; $cmd2.CommandTimeout = 30
    $da2 = New-Object System.Data.SqlClient.SqlDataAdapter $cmd2
    $dt2 = New-Object System.Data.DataTable; $da2.Fill($dt2) | Out-Null
    $rows2 = @()
    foreach ($r in $dt2.Rows) {
        $moy = if ($r["moy_tentatives"] -is [System.DBNull]) { $null } else { [double]$r["moy_tentatives"] }
        $rows2 += @{
            idCampanya  = [string]$r["IDCAMPANYA"]
            total       = [int]$r["total"]
            disponibles = [int]$r["disponibles"]
            terminees   = [int]$r["terminees"]
            moy_tentatives = $moy
        }
    }
    $sqlFiles = $rows2

    # Stats par agent x campagne (production individuelle, fiches definitives)
    $q3 = @"
SELECT
    t.idAgente,
    t.idCampanya,
    c.NOMBRE                                                        AS campNom,
    COUNT(*)                                                        AS nb,
    SUM(CASE WHEN ISNULL(f.CONTACTADO,0) >= 2 THEN 1 ELSE 0 END)   AS cuPos,
    SUM(CASE WHEN ISNULL(f.CONTACTADO,0) > 0  THEN 1 ELSE 0 END)   AS cuTotal,
    SUM(CASE
        WHEN t.idFinal NOT IN (1, 19)
         AND LOWER(ISNULL(f.DESCRIPCION,'')) NOT LIKE '%rappel%'
         AND ISNULL(f.CONTACTADO, 0) <> 1
        THEN 1 ELSE 0 END)                                          AS definitifs,
    DATEDIFF(second, MIN(t.tInicio),
        MAX(CASE WHEN t.tFinal IS NOT NULL
                 THEN DATEADD(second, ISNULL(t.nTAdmin, 0), t.tFinal)
                 ELSE t.tInicio END))                               AS session_span_sec,
    AVG(CASE WHEN t.nTAdmin > 0 THEN CAST(t.nTAdmin AS float) ELSE NULL END) AS dmt_sec
FROM TRANSACCION t WITH (NOLOCK)
LEFT JOIN CAMPANYA c WITH (NOLOCK) ON c.IDCAMPANYA = t.idCampanya
LEFT JOIN FINALES  f WITH (NOLOCK) ON f.IDCAMPANYA = t.idCampanya AND f.IDFINAL = t.idFinal
WHERE t.tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
  AND t.tInicio <  DATEADD(day,1,CAST(CAST(GETDATE() AS date) AS datetime))
  AND t.nOrigenTransaccion IN (4,5)
  AND t.Estado = 1
GROUP BY t.idAgente, t.idCampanya, c.NOMBRE
ORDER BY t.idAgente, COUNT(*) DESC
"@
    $cmd3 = $sc.CreateCommand(); $cmd3.CommandText = $q3; $cmd3.CommandTimeout = 30
    $da3 = New-Object System.Data.SqlClient.SqlDataAdapter $cmd3
    $dt3 = New-Object System.Data.DataTable; $da3.Fill($dt3) | Out-Null
    $rows3 = @()
    foreach ($r in $dt3.Rows) {
        $dmtA = if ($r["dmt_sec"] -is [System.DBNull]) { $null } else { [double]$r["dmt_sec"] }
        $spanA = if ($r["session_span_sec"] -is [System.DBNull]) { 0 } else { [long]$r["session_span_sec"] }
        $rows3 += @{
            idAgente         = [string]$r["idAgente"]
            idCampanya       = [string]$r["idCampanya"]
            campNom          = [string]$r["campNom"]
            nb               = [int]$r["nb"]
            cuPos            = [int]$r["cuPos"]
            cuTotal          = [int]$r["cuTotal"]
            definitifs       = [int]$r["definitifs"]
            session_span_sec = $spanA
            dmt_sec          = $dmtA
        }
    }
    $sqlAgentCamps = $rows3

    # Diagnostic (LECTURE SEULE) : repartition des transactions du jour par origine et
    # etat. Permet de voir quels codes nOrigenTransaccion / Estado correspondent aux
    # tentatives du composeur (non-joignables) exclues du comptage "appels traites".
    $q4 = @"
SELECT
    t.nOrigenTransaccion        AS origine,
    t.Estado                    AS etat,
    COUNT(*)                    AS nb
FROM TRANSACCION t WITH (NOLOCK)
WHERE t.tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
  AND t.tInicio <  DATEADD(day,1,CAST(CAST(GETDATE() AS date) AS datetime))
GROUP BY t.nOrigenTransaccion, t.Estado
ORDER BY COUNT(*) DESC
"@
    $cmd4 = $sc.CreateCommand(); $cmd4.CommandText = $q4; $cmd4.CommandTimeout = 30
    $da4 = New-Object System.Data.SqlClient.SqlDataAdapter $cmd4
    $dt4 = New-Object System.Data.DataTable; $da4.Fill($dt4) | Out-Null
    $rows4 = @()
    foreach ($r in $dt4.Rows) {
        $rows4 += @{
            origine = if ($r["origine"] -is [System.DBNull]) { $null } else { [int]$r["origine"] }
            etat    = if ($r["etat"]    -is [System.DBNull]) { $null } else { [int]$r["etat"] }
            nb      = [int]$r["nb"]
        }
    }
    $sqlDiag = $rows4

    $sc.Close()
    Write-Log ("SQL OK : " + $rows1.Count + " lignes stats, " + $rows2.Count + " campagnes fichier, " + $rows3.Count + " lignes agent x campagne, " + $rows4.Count + " lignes diagnostic")
} catch {
    Write-Log ("AVERTISSEMENT SQL (lecture seule) : " + $_.Exception.Message + " - envoi sans stats SQL.")
}

try {
    $body = @{ campaigns = $campaigns; agents = $agents; estado = $estado; sqlStats = $sqlStats; sqlFiles = $sqlFiles; sqlAgentCamps = $sqlAgentCamps; sqlDiag = $sqlDiag } | ConvertTo-Json -Depth 12 -Compress
    $pushHeaders = @{ "X-Evo-Push-Secret" = $PushSecret; "Content-Type" = "application/json" }
    $resp = Invoke-RestMethod -Uri $DashboardUrl -Headers $pushHeaders -Method Post -Body $body -TimeoutSec 15

    if ($resp.ok) {
        Write-Log "Envoi OK (reçu par le tableau de bord à $($resp.receivedAt))"
    } else {
        Write-Log "Envoi refusé par le tableau de bord : $($resp.error)"
    }
} catch {
    Write-Log "ERREUR (côté tableau de bord, vérifier EVO_PUSH_SECRET sur Railway) : $($_.Exception.Message)"
}
