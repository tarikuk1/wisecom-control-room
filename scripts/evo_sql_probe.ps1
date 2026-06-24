<#
  evo_sql_probe.ps1 - LECTURE SEULE - Exploration de la base SQL Evolution

  A QUOI CA SERT
  Avant de pouvoir calculer les indicateurs detailles (DMC, DMT, temps d'attente,
  refus, faux numero, taux de contact, etc.), il faut connaitre deux choses qu'on
  ne peut pas deviner :
    1) le NOM exact de la base de donnees Evolution sur le serveur SQL ;
    2) la liste des CODES DE RESOLUTION (table FINALES) - c'est ce qui distingue
       un accord, un refus, un faux numero, etc. (chaque campagne les configure
       a sa maniere).

  Ce script se CONNECTE en LECTURE SEULE au serveur SQL, lit ces informations,
  et les enregistre dans un fichier texte (evo_sql_probe_output.txt) que vous
  pourrez renvoyer. IL NE MODIFIE RIEN : uniquement des requetes SELECT, en mode
  "READ UNCOMMITTED" (aucun verrou pose, aucun ralentissement pour les agents).

  COMMENT LANCER
  1) Copier ce fichier sur le poste du bureau (ou sur le serveur) qui peut
     atteindre le serveur SQL 45.129.110.3.
  2) Clic droit -> Executer avec PowerShell  (ou dans une fenetre PowerShell :
       powershell -ExecutionPolicy Bypass -File "C:\chemin\evo_sql_probe.ps1" )
  3) A la fin, un fichier evo_sql_probe_output.txt est cree a cote du script.
     Renvoyez ce fichier.
#>

# == A CONFIGURER (deja rempli d'apres la fiche infra) =========================
$SqlServer = "45.129.110.3"          # serveur SQL (instance EVO1)
$SqlUser   = "sa"
$SqlPwd    = "Kj41mg65e!"
# ==============================================================================

$ErrorActionPreference = "Stop"
$OutFile = Join-Path $PSScriptRoot "evo_sql_probe_output.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Out2($t){ $lines.Add([string]$t); Write-Host $t }

# Connexion ADO.NET (System.Data.SqlClient est present sur tout Windows).
# LECTURE SEULE : on n'execute que des SELECT, en READ UNCOMMITTED (sans verrou).
function Open-Conn($database){
    $cs = "Server=$SqlServer;Database=$database;User Id=$SqlUser;Password=$SqlPwd;" +
          "Encrypt=False;TrustServerCertificate=True;Connect Timeout=15"
    $c = New-Object System.Data.SqlClient.SqlConnection $cs
    $c.Open()
    $cmd = $c.CreateCommand()
    $cmd.CommandText = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;"
    $cmd.ExecuteNonQuery() | Out-Null
    return $c
}
function Run-Query($conn,$sql){
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 60
    $da = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $dt = New-Object System.Data.DataTable
    $da.Fill($dt) | Out-Null
    return $dt
}
function Dump-Table($dt,$maxRows){
    if($dt.Rows.Count -eq 0){ Out2 "   (aucune ligne)"; return }
    $cols = @(); foreach($c in $dt.Columns){ $cols += $c.ColumnName }
    Out2 ("   " + ($cols -join " | "))
    $n = 0
    foreach($row in $dt.Rows){
        if($n -ge $maxRows){ Out2 ("   ... (" + ($dt.Rows.Count - $maxRows) + " lignes supplementaires non affichees)"); break }
        $vals = @(); foreach($c in $dt.Columns){ $v = $row[$c.ColumnName]; if($v -is [System.DBNull]){ $v = "" }; $vals += [string]$v }
        Out2 ("   " + ($vals -join " | "))
        $n++
    }
}

Out2 "=============================================================="
Out2 (" Sonde SQL Evolution - LECTURE SEULE - " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Out2 "=============================================================="

# --- 1) Connexion + version --------------------------------------------------
$master = $null
try {
    $master = Open-Conn "master"
    $v = Run-Query $master "SELECT @@VERSION AS v, @@SERVERNAME AS srv"
    Out2 ""
    Out2 "[1] Connexion OK."
    Out2 ("    Serveur : " + $v.Rows[0]["srv"])
    Out2 ("    Version : " + (($v.Rows[0]["v"] -split "`n")[0]).Trim())
} catch {
    Out2 ""
    Out2 "[1] ECHEC DE CONNEXION au serveur SQL."
    Out2 ("    Detail : " + $_.Exception.Message)
    Out2 "    -> Verifier que ce poste atteint bien 45.129.110.3 (port 1433),"
    Out2 "       et que l'identifiant sa / mot de passe sont corrects."
    $lines | Out-File -FilePath $OutFile -Encoding UTF8
    Write-Host ""
    Write-Host ("Resultat enregistre dans : " + $OutFile)
    exit 1
}

# --- 2) Liste des bases de donnees -------------------------------------------
Out2 ""
Out2 "[2] Bases de donnees presentes :"
$dbs = Run-Query $master "SELECT name FROM sys.databases WHERE state = 0 AND database_id > 4 ORDER BY name"
$dbNames = @()
foreach($r in $dbs.Rows){ $dbNames += [string]$r["name"]; Out2 ("    - " + $r["name"]) }
if($dbNames.Count -eq 0){ Out2 "    (aucune base utilisateur trouvee)" }

# --- 3) Detection de la base Evolution (celle qui contient TRANSACCION) ------
Out2 ""
Out2 "[3] Recherche de la base Evolution (table TRANSACCION + FINALES) :"
$evoDb = $null
foreach($db in $dbNames){
    try {
        $chk = Run-Query $master ("SELECT COUNT(*) AS n FROM [" + $db + "].sys.tables WHERE name IN ('TRANSACCION','FINALES','CAMPANYA')")
        $n = [int]$chk.Rows[0]["n"]
        Out2 ("    - " + $db + " : " + $n + "/3 tables cles trouvees")
        if($n -ge 2 -and -not $evoDb){ $evoDb = $db }
    } catch {
        Out2 ("    - " + $db + " : non inspectable (" + $_.Exception.Message + ")")
    }
}
$master.Close()

if(-not $evoDb){
    Out2 ""
    Out2 "    Aucune base ne contient les tables Evolution attendues."
    Out2 "    -> Renvoyez quand meme ce fichier, on regardera la liste des bases."
    $lines | Out-File -FilePath $OutFile -Encoding UTF8
    Write-Host ""; Write-Host ("Resultat enregistre dans : " + $OutFile)
    exit 0
}
Out2 ("    => Base Evolution detectee : " + $evoDb)

# --- Connexion a la base Evolution -------------------------------------------
$evo = Open-Conn $evoDb

# --- 4) Codes de resolution (FINALES) ----------------------------------------
Out2 ""
Out2 "[4] Colonnes de la table FINALES :"
try {
    $cols = Run-Query $evo "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='FINALES' ORDER BY ORDINAL_POSITION"
    Dump-Table $cols 100
} catch { Out2 ("   erreur : " + $_.Exception.Message) }

Out2 ""
Out2 "[4b] Contenu de FINALES (codes de resolution - tout le tableau) :"
try {
    $fin = Run-Query $evo "SELECT TOP 300 * FROM FINALES"
    Dump-Table $fin 300
} catch { Out2 ("   erreur : " + $_.Exception.Message) }

# --- 5) Campagnes (CAMPANYA) -------------------------------------------------
Out2 ""
Out2 "[5] Colonnes de la table CAMPANYA :"
try {
    $cc = Run-Query $evo "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='CAMPANYA' ORDER BY ORDINAL_POSITION"
    Dump-Table $cc 200
} catch { Out2 ("   erreur : " + $_.Exception.Message) }

Out2 ""
Out2 "[5b] Echantillon de CAMPANYA (20 premieres) :"
try {
    $camp = Run-Query $evo "SELECT TOP 20 * FROM CAMPANYA"
    Dump-Table $camp 20
} catch { Out2 ("   erreur : " + $_.Exception.Message) }

# --- 6) Echantillon de stats du jour (transactions sortantes) ----------------
# Demonstration que les chiffres sont accessibles. Strictement en lecture.
Out2 ""
Out2 "[6] Stats du jour - transactions (echantillon, lecture seule) :"
try {
    $agg = Run-Query $evo @"
SELECT
    COUNT(*)                                            AS nb_transactions,
    SUM(CASE WHEN nCU > 0 THEN 1 ELSE 0 END)            AS nb_contacts_utiles,
    AVG(CAST(nTQ AS float))                             AS moy_secondes_file,
    AVG(CAST(nTAdmin AS float))                         AS moy_secondes_wrapup,
    AVG(CAST(DATEDIFF(second, tInicio, tFinal) AS float)) AS moy_secondes_agent
FROM TRANSACCION
WHERE tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
  AND tInicio <  DATEADD(day, 1, CAST(CAST(GETDATE() AS date) AS datetime))
"@
    Dump-Table $agg 5
} catch { Out2 ("   erreur : " + $_.Exception.Message) }

Out2 ""
Out2 "[6b] Stats du jour - repartition par code de resolution (idFinal) :"
try {
    $byf = Run-Query $evo @"
SELECT TOP 50
    t.idFinal,
    f.Nombre        AS nom_code,
    COUNT(*)        AS nb
FROM TRANSACCION t
LEFT JOIN FINALES f ON f.idFinal = t.idFinal
WHERE t.tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
GROUP BY t.idFinal, f.Nombre
ORDER BY COUNT(*) DESC
"@
    Dump-Table $byf 50
} catch {
    Out2 ("   (note : la colonne FINALES.Nombre n'existe peut-etre pas - voir section [4]. Detail : " + $_.Exception.Message + ")")
    Out2 "   Nouvel essai sans le nom du code :"
    try {
        $byf2 = Run-Query $evo @"
SELECT TOP 50 t.idFinal, COUNT(*) AS nb
FROM TRANSACCION t
WHERE t.tInicio >= CAST(CAST(GETDATE() AS date) AS datetime)
GROUP BY t.idFinal ORDER BY COUNT(*) DESC
"@
        Dump-Table $byf2 50
    } catch { Out2 ("   erreur : " + $_.Exception.Message) }
}

$evo.Close()

Out2 ""
Out2 "=============================================================="
Out2 " Termine. Aucune donnee n'a ete modifiee (lecture seule)."
Out2 "=============================================================="
$lines | Out-File -FilePath $OutFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat enregistre dans : " + $OutFile)
Write-Host "Renvoyez ce fichier evo_sql_probe_output.txt."
