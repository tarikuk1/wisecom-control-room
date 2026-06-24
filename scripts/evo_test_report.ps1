# evo_test_report.ps1 - Trouve le bon format de parametres pour le rapport 100000012.
# Insight doc: les heures (hdesde/hhasta) sont des NOMBRES (0 a 2400), pas "HH:mm:ss".
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
    } catch { return $null }
}

function Invoke-EvoReport($ReportId, $Body, $Label) {
    Write-Host ("=== {0} (rapport {1}) ===" -f $Label, $ReportId)
    try {
        $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
        $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Post -Body $Body -TimeoutSec 60 -UseBasicParsing
        $json = $resp.Content | ConvertFrom-Json
        $rowsCount = 0
        if ($json.ReportData -and $json.ReportData.RowsCount) { $rowsCount = $json.ReportData.RowsCount }
        Write-Host ("  OK (200) - {0} lignes" -f $rowsCount)
        return @{ label=$Label; reportId=$ReportId; bodySent=$Body; ok=$true; rowsCount=$rowsCount; response=$json }
    } catch {
        $errBody = Read-ErrorBody $_
        Write-Host ("  ERREUR : {0}" -f $_.Exception.Message)
        return @{ label=$Label; reportId=$ReportId; bodySent=$Body; ok=$false; errorMessage=$_.Exception.Message; errorBody=$errBody }
    }
}

$d_iso = "2026-06-23"
$d_fr  = "23/06/2026"

$tests = @()

# V1 : ids=-1 (string), dates ISO, HEURES = NOMBRES 0 et 2400, transorg=-1
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},' +
  '{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},' +
  '{"Name":"fdesde","Value":"'+$d_iso+'"},{"Name":"fhasta","Value":"'+$d_iso+'"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400},{"Name":"transorg","Value":"-1"}]}') "V1_ids-1_ISO_heuresNombres"

# V2 : ids=0, dates ISO, heures nombres
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"0"},{"Name":"idcampa","Value":"0"},{"Name":"idsegm","Value":"0"},' +
  '{"Name":"idagent","Value":"0"},{"Name":"idfinal","Value":"0"},' +
  '{"Name":"fdesde","Value":"'+$d_iso+'"},{"Name":"fhasta","Value":"'+$d_iso+'"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400},{"Name":"transorg","Value":"0"}]}') "V2_ids0_ISO_heuresNombres"

# V3 : seulement dates + heures nombres (pas d'ids)
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"fdesde","Value":"'+$d_iso+'"},{"Name":"fhasta","Value":"'+$d_iso+'"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400}]}') "V3_datesISO_heuresNombres_seul"

# V4 : dates FR + heures nombres
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},' +
  '{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},' +
  '{"Name":"fdesde","Value":"'+$d_fr+'"},{"Name":"fhasta","Value":"'+$d_fr+'"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400},{"Name":"transorg","Value":"-1"}]}') "V4_ids-1_FR_heuresNombres"

# V5 : dates ISO avec heure "yyyy-MM-dd HH:mm:ss", heures nombres
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},' +
  '{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},' +
  '{"Name":"fdesde","Value":"2026-06-23 00:00:00"},{"Name":"fhasta","Value":"2026-06-23 23:59:59"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400},{"Name":"transorg","Value":"-1"}]}') "V5_datetimeSpace_heuresNombres"

# V6 : heures en string "0"/"2400"
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},' +
  '{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},' +
  '{"Name":"fdesde","Value":"'+$d_iso+'"},{"Name":"fhasta","Value":"'+$d_iso+'"},' +
  '{"Name":"hdesde","Value":"0"},{"Name":"hhasta","Value":"2400"},{"Name":"transorg","Value":"-1"}]}') "V6_heuresStringNombres"

# V7 : tout en nombres (ids entiers -1, heures nombres, transorg entier)
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":-1},{"Name":"idcampa","Value":-1},{"Name":"idsegm","Value":-1},' +
  '{"Name":"idagent","Value":-1},{"Name":"idfinal","Value":-1},' +
  '{"Name":"fdesde","Value":"'+$d_iso+'"},{"Name":"fhasta","Value":"'+$d_iso+'"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400},{"Name":"transorg","Value":-1}]}') "V7_idsEntiers_heuresNombres"

# V8 : dates format compact yyyyMMdd, heures nombres
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},' +
  '{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},' +
  '{"Name":"fdesde","Value":"20260623"},{"Name":"fhasta","Value":"20260623"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2400},{"Name":"transorg","Value":"-1"}]}') "V8_datesCompact_heuresNombres"

# V9 : heures 0 et 2359
$tests += Invoke-EvoReport 100000012 ('{"Parameters":[' +
  '{"Name":"idsvc","Value":"-1"},{"Name":"idcampa","Value":"-1"},{"Name":"idsegm","Value":"-1"},' +
  '{"Name":"idagent","Value":"-1"},{"Name":"idfinal","Value":"-1"},' +
  '{"Name":"fdesde","Value":"'+$d_iso+'"},{"Name":"fhasta","Value":"'+$d_iso+'"},' +
  '{"Name":"hdesde","Value":0},{"Name":"hhasta","Value":2359},{"Name":"transorg","Value":"-1"}]}') "V9_heures0_2359"

$tests | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat enregistre dans : {0}" -f $OutputFile)
Write-Host "Regarde quelle ligne affiche 'OK (200)' au lieu de 'ERREUR'."
