# evo_test_report.ps1 - Recupere les definitions des rapports Evolution
# pour connaitre les noms exacts des parametres attendus.
# Resultat enregistre dans evo_test_report_output.json (a envoyer pour analyse).

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"
$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"

$ErrorActionPreference = "Continue"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$webHeaders = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

function Get-EvoReportDef($ReportId, $Label) {
    Write-Host ("=== DEF {0} (rapport {1}) ===" -f $Label, $ReportId)
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId" + "?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Get -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $paramNames = @()
        if ($json.Parameters) {
            foreach ($p in $json.Parameters) { $paramNames += $p.Name }
        }
        Write-Host ("OK - parametres: {0}" -f ($paramNames -join ", "))
        return @{
            kind = "definition"
            label = $Label
            reportId = $ReportId
            ok = $true
            definition = $json
        }
    } catch {
        Write-Host ("ERREUR : {0}" -f $_.Exception.Message)
        return @{
            kind = "definition"
            label = $Label
            reportId = $ReportId
            ok = $false
            error = $_.Exception.Message
        }
    }
}

function Invoke-EvoReport($ReportId, $Params, $Label) {
    $body = @{ Parameters = $Params } | ConvertTo-Json -Depth 5
    Write-Host ("=== INVOKE {0} (rapport {1}) ===" -f $Label, $ReportId)
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Post -Body $body -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $rowsCount = 0
        if ($json.ReportData -and $json.ReportData.RowsCount) { $rowsCount = $json.ReportData.RowsCount }
        Write-Host ("OK - {0} lignes" -f $rowsCount)
        return @{
            kind = "invoke"
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
            kind = "invoke"
            label = $Label
            reportId = $ReportId
            params = $Params
            ok = $false
            error = $_.Exception.Message
        }
    }
}

$tests = @()

# Etape 1 : recuperer la definition (liste des parametres attendus) des 4 rapports
$tests += Get-EvoReportDef 100000012 "Def_Num_trans_AgenCamp"
$tests += Get-EvoReportDef 100000013 "Def_Num_trans_CampFin"
$tests += Get-EvoReportDef 100000030 "Def_TM_trans_AgenCamp"
$tests += Get-EvoReportDef 100000055 "Def_Participaciones_CampAgen"

$tests | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat enregistre dans : {0}" -f $OutputFile)
