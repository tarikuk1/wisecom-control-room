# evo_test_report.ps1 - Capture le corps de la reponse en cas d'erreur 500
# pour comprendre ce qu'Evolution reproche aux valeurs des parametres.
# Resultat enregistre dans evo_test_report_output.json (a envoyer pour analyse).

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"
$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"

$ErrorActionPreference = "Continue"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$webHeaders = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

function Read-ErrorBody($Err) {
    try {
        $resp = $Err.Exception.Response
        if ($resp -eq $null) { return $null }
        $stream = $resp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        $reader.Close()
        return $body
    } catch {
        return ("Impossible de lire le corps : " + $_.Exception.Message)
    }
}

function Invoke-EvoReport($ReportId, $Body, $Label) {
    Write-Host ("=== {0} (rapport {1}) ===" -f $Label, $ReportId)
    Write-Host ("Body envoye : {0}" -f $Body)
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Post -Body $Body -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $rowsCount = 0
        if ($json.ReportData -and $json.ReportData.RowsCount) { $rowsCount = $json.ReportData.RowsCount }
        Write-Host ("OK - {0} lignes" -f $rowsCount)
        return @{
            label = $Label
            reportId = $ReportId
            bodySent = $Body
            ok = $true
            rowsCount = $rowsCount
            response = $json
        }
    } catch {
        $errBody = Read-ErrorBody $_
        Write-Host ("ERREUR HTTP : {0}" -f $_.Exception.Message)
        Write-Host ("Corps de la reponse : {0}" -f $errBody)
        return @{
            label = $Label
            reportId = $ReportId
            bodySent = $Body
            ok = $false
            errorMessage = $_.Exception.Message
            errorBody = $errBody
        }
    }
}

$today_iso = Get-Date -Format "yyyy-MM-dd"

$tests = @()

# Controle : pas de parametres (on sait que ca renvoie 0 lignes sans erreur)
$tests += Invoke-EvoReport 100000012 '{"Parameters":[]}' "Ctrl_vide"

# Test 1 : valeurs string -1
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
    '{"Name":"idsvc","Value":"-1"},' +
    '{"Name":"idcampa","Value":"-1"},' +
    '{"Name":"idsegm","Value":"-1"},' +
    '{"Name":"idagent","Value":"-1"},' +
    '{"Name":"idfinal","Value":"-1"},' +
    '{"Name":"fdesde","Value":"' + $today_iso + '"},' +
    '{"Name":"fhasta","Value":"' + $today_iso + '"},' +
    '{"Name":"hdesde","Value":"00:00:00"},' +
    '{"Name":"hhasta","Value":"23:59:59"},' +
    '{"Name":"transorg","Value":"-1"}' +
']}') "T1_string_moins1_ISO"

# Test 2 : valeurs entieres -1 (pas de guillemets autour)
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
    '{"Name":"idsvc","Value":-1},' +
    '{"Name":"idcampa","Value":-1},' +
    '{"Name":"idsegm","Value":-1},' +
    '{"Name":"idagent","Value":-1},' +
    '{"Name":"idfinal","Value":-1},' +
    '{"Name":"fdesde","Value":"' + $today_iso + '"},' +
    '{"Name":"fhasta","Value":"' + $today_iso + '"},' +
    '{"Name":"hdesde","Value":"00:00:00"},' +
    '{"Name":"hhasta","Value":"23:59:59"},' +
    '{"Name":"transorg","Value":-1}' +
']}') "T2_int_moins1_ISO"

# Test 3 : seulement les dates (pas d'IDs)
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
    '{"Name":"fdesde","Value":"' + $today_iso + '"},' +
    '{"Name":"fhasta","Value":"' + $today_iso + '"},' +
    '{"Name":"hdesde","Value":"00:00:00"},' +
    '{"Name":"hhasta","Value":"23:59:59"}' +
']}') "T3_dates_seules"

# Test 4 : un seul parametre (fdesde) pour voir si l'erreur est plus parlante
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
    '{"Name":"fdesde","Value":"' + $today_iso + '"}' +
']}') "T4_fdesde_seul"

# Test 5 : nom de cle "value" en minuscules
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
    '{"name":"idsvc","value":"-1"},' +
    '{"name":"fdesde","value":"' + $today_iso + '"}' +
']}') "T5_keys_minuscules"

$tests | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat enregistre dans : {0}" -f $OutputFile)
