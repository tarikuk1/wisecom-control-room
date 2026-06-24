# evo_test_report.ps1 - Sans hdesde/hhasta (ces 2 paramètres causent l'erreur 500).
# On teste uniquement fdesde/fhasta sur différentes périodes pour obtenir des données.
# Résultat enregistré dans evo_test_report_output.json

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"
$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"
$ErrorActionPreference = "Continue"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$webHeaders = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

function Invoke-EvoReport($ReportId, $Body, $Label) {
    Write-Host ("=== {0} ===" -f $Label)
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Post -Body $Body -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $rowsCount = 0
        if ($json.ReportData -and $json.ReportData.RowsCount) { $rowsCount = $json.ReportData.RowsCount }
        Write-Host ("  OK - {0} lignes" -f $rowsCount)
        return @{ label=$Label; reportId=$ReportId; ok=$true; rowsCount=$rowsCount; response=$json }
    } catch {
        Write-Host ("  ERREUR : {0}" -f $_.Exception.Message)
        return @{ label=$Label; reportId=$ReportId; ok=$false; error=$_.Exception.Message }
    }
}

$today    = Get-Date -Format "yyyy-MM-dd"
$today_fr = Get-Date -Format "dd/MM/yyyy"
$d7       = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
$d30      = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd")
$d7fr     = (Get-Date).AddDays(-7).ToString("dd/MM/yyyy")
$d30fr    = (Get-Date).AddDays(-30).ToString("dd/MM/yyyy")

$tests = @()

# Rapport 100000012 - SANS hdesde/hhasta (ceux-ci causent 500)
# A: dates ISO, 30 jours, pas d IDs
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[{"Name":"fdesde","Value":"'+$d30+'"},{"Name":"fhasta","Value":"'+$today+'"}]}') "12_A_ISO_30j_sansIDs"

# B: dates ISO, 7 jours, pas d IDs
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[{"Name":"fdesde","Value":"'+$d7+'"},{"Name":"fhasta","Value":"'+$today+'"}]}') "12_B_ISO_7j_sansIDs"

# C: dates FR, 30 jours, pas d IDs
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[{"Name":"fdesde","Value":"'+$d30fr+'"},{"Name":"fhasta","Value":"'+$today_fr+'"}]}') "12_C_FR_30j_sansIDs"

# D: dates ISO, 30 jours + IDs=-1
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},{"Name":"fdesde","Value":"'+$d30+'"},{"Name":"fhasta","Value":"'+$today+'"},{"Name":"transorg","Value":"-1"}]}') "12_D_ISO_30j_IDs-1"

# E: dates FR, 30 jours + IDs=-1
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},{"Name":"fdesde","Value":"'+$d30fr+'"},{"Name":"fhasta","Value":"'+$today_fr+'"},{"Name":"transorg","Value":"-1"}]}') "12_E_FR_30j_IDs-1"

# Rapport 100000055 - participation agents (a son propre parametre estadosesion)
# F: dates ISO 30j sans IDs (rapport 55)
$tests += Invoke-EvoReport 100000055 ('{"Parameters":[{"Name":"fdesde","Value":"'+$d30+'"},{"Name":"fhasta","Value":"'+$today+'"}]}') "55_F_ISO_30j_sansIDs"

# G: dates FR 30j sans IDs (rapport 55)
$tests += Invoke-EvoReport 100000055 ('{"Parameters":[{"Name":"fdesde","Value":"'+$d30fr+'"},{"Name":"fhasta","Value":"'+$today_fr+'"}]}') "55_G_FR_30j_sansIDs"

$tests | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat dans : {0}" -f $OutputFile)
