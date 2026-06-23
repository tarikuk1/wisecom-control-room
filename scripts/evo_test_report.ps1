# evo_test_report.ps1 - Teste plusieurs rapports Evolution.
# Resultat enregistre dans evo_test_report_output.json (a envoyer pour analyse).

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"
$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"

$ErrorActionPreference = "Continue"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$webHeaders = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

function Invoke-EvoReport($ReportId, $Params, $Label) {
    $body = @{ Parameters = $Params } | ConvertTo-Json -Depth 5
    Write-Host ("=== {0} (rapport {1}) ===" -f $Label, $ReportId)
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Post -Body $body -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $rowsCount = 0
        if ($json.ReportData -and $json.ReportData.RowsCount) { $rowsCount = $json.ReportData.RowsCount }
        Write-Host ("OK - {0} lignes" -f $rowsCount)
        return @{
            label = $Label
            reportId = $ReportId
            params = $Params
            ok = $true
            rowsCount = $rowsCount
            response = $json
        }
    } catch {
        Write-Host ("ERREUR : {0}" -f $_.Exception.Message)
        return @{
            label = $Label
            reportId = $ReportId
            params = $Params
            ok = $false
            error = $_.Exception.Message
        }
    }
}

$today = Get-Date -Format "yyyy-MM-dd"
$today_fr = Get-Date -Format "dd/MM/yyyy"
$sevenDaysAgo = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
$thirtyDaysAgo = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd")

$tests = @()

# Rapports SANS parametres (on a vu que Estado de listas marche comme ca)
$tests += Invoke-EvoReport 100000035 @() "Estado_listas_noparams"
$tests += Invoke-EvoReport 100000012 @() "Num_trans_AgenCamp_noparams"
$tests += Invoke-EvoReport 100000013 @() "Num_trans_CampFin_noparams"
$tests += Invoke-EvoReport 100000030 @() "TM_trans_AgenCamp_noparams"
$tests += Invoke-EvoReport 100000055 @() "Participaciones_CampAgen_noparams"

$tests | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat enregistre dans : {0}" -f $OutputFile)
