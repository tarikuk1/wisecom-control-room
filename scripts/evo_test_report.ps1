<#
  evo_test_report.ps1 — Teste plusieurs rapports Evolution et enregistre toutes les réponses
  dans evo_test_report_output.json (un seul fichier qui contient tout).

  COMMENT L'UTILISER
  1) Mets ce fichier dans C:\evo_push\ (à côté de evo_push.ps1)
  2) Lance dans PowerShell :
        powershell -ExecutionPolicy Bypass -File "C:\evo_push\evo_test_report.ps1"
  3) Ouvre evo_test_report_output.json et envoie-moi son contenu
#>

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"
$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"

$ErrorActionPreference = "Continue"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

function Invoke-EvoReport($ReportId, $Params, $Label) {
    $body = @{ Parameters = $Params } | ConvertTo-Json -Depth 5
    Write-Host "=== $Label (rapport $ReportId) ==="
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $headers -Method Post -Body $body -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $rowsCount = if ($json.ReportData.RowsCount) { $json.ReportData.RowsCount } else { 0 }
        Write-Host "OK - $rowsCount lignes"
        return @{
            label   = $Label
            reportId = $ReportId
            params  = $Params
            ok      = $true
            rowsCount = $rowsCount
            response = $json
        }
    } catch {
        Write-Host "ERREUR : $($_.Exception.Message)"
        return @{
            label   = $Label
            reportId = $ReportId
            params  = $Params
            ok      = $false
            error   = $_.Exception.Message
        }
    }
}

$today    = Get-Date -Format "yyyy-MM-dd"
$today_fr = Get-Date -Format "dd/MM/yyyy"
$sevenDaysAgo = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
$sevenDaysAgo_fr = (Get-Date).AddDays(-7).ToString("dd/MM/yyyy")
$thirtyDaysAgo = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd")

$tests = @()

# Test 1 : Estado de listas - aujourd'hui, format ISO
$tests += Invoke-EvoReport 100000035 @(
    @{ Name = "fdesde"; Value = "$($today)T00:00:00" }
    @{ Name = "fhasta"; Value = "$($today)T23:59:59" }
) "Estado de listas — aujourd'hui (ISO)"

# Test 2 : Estado de listas - aujourd'hui, format français
$tests += Invoke-EvoReport 100000035 @(
    @{ Name = "fdesde"; Value = "$today_fr 00:00:00" }
    @{ Name = "fhasta"; Value = "$today_fr 23:59:59" }
) "Estado de listas — aujourd'hui (FR)"

# Test 3 : Estado de listas - 7 derniers jours
$tests += Invoke-EvoReport 100000035 @(
    @{ Name = "fdesde"; Value = "$($sevenDaysAgo)T00:00:00" }
    @{ Name = "fhasta"; Value = "$($today)T23:59:59" }
) "Estado de listas — 7 derniers jours"

# Test 4 : Estado de listas - 30 derniers jours
$tests += Invoke-EvoReport 100000035 @(
    @{ Name = "fdesde"; Value = "$($thirtyDaysAgo)T00:00:00" }
    @{ Name = "fhasta"; Value = "$($today)T23:59:59" }
) "Estado de listas — 30 derniers jours"

# Test 5 : Estado de listas - sans dates (au cas où)
$tests += Invoke-EvoReport 100000035 @() "Estado de listas — sans paramètres"

# Test 6 : Num. trans Agen vs Camp - aujourd'hui (pour comparer)
$tests += Invoke-EvoReport 100000012 @(
    @{ Name = "fdesde"; Value = "$($today)T00:00:00" }
    @{ Name = "fhasta"; Value = "$($today)T23:59:59" }
) "Num. trans Agen vs Camp — aujourd'hui"

# Test 7 : Num. transacciones (Camp,Fin) - aujourd'hui
$tests += Invoke-EvoReport 100000013 @(
    @{ Name = "fdesde"; Value = "$($today)T00:00:00" }
    @{ Name = "fhasta"; Value = "$($today)T23:59:59" }
) "Num. transacciones Camp Fin — aujourd'hui"

$tests | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host "Résultat enregistré dans : $OutputFile"
