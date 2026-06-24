# evo_test_report.ps1 - Affiche le contenu du rapport "Estado de listas" (100000035)
# pour verifier quelles campagnes et quels chiffres il renvoie.
# Resultat aussi enregistre dans evo_test_report_output.json

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"
$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"
$ErrorActionPreference = "Continue"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$webHeaders = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

$url = "https://$EvoHost/manager/api/v1/admin/reports/100000035/invoke?format=json"
try {
    $resp = Invoke-WebRequest -Uri $url -Headers $webHeaders -Method Post -Body '{"Parameters":[]}' -TimeoutSec 60 -UseBasicParsing
    $json = $resp.Content | ConvertFrom-Json
} catch {
    Write-Host ("ERREUR : {0}" -f $_.Exception.Message)
    exit 1
}

$rd = $json.ReportData
$heads = @()
foreach ($h in $rd.Headers) { $heads += $h.Header }
Write-Host ("Colonnes : {0}" -f ($heads -join " | "))
Write-Host ("Nombre de lignes : {0}" -f $rd.RowsCount)
Write-Host "----------------------------------------"

# Index des colonnes utiles
$iCamp = [Array]::IndexOf($heads, "Campaign")
$iImp  = [Array]::IndexOf($heads, "Imported")
$iPend = [Array]::IndexOf($heads, "Pending")
$iAvail= [Array]::IndexOf($heads, "Total_Available")
$iFin  = [Array]::IndexOf($heads, "Finished")
$iNew  = [Array]::IndexOf($heads, "New")

foreach ($row in $rd.Rows) {
    $v = $row.Values
    $camp = if ($iCamp -ge 0) { $v[$iCamp] } else { "?" }
    $imp  = if ($iImp  -ge 0) { $v[$iImp]  } else { "" }
    $av   = if ($iAvail-ge 0) { $v[$iAvail]} else { "" }
    $fin  = if ($iFin  -ge 0) { $v[$iFin]  } else { "" }
    $new  = if ($iNew  -ge 0) { $v[$iNew]  } else { "" }
    Write-Host ("{0}  | recu={1} dispo={2} conclu={3} vierge={4}" -f $camp, $imp, $av, $fin, $new)
}

$json | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host "----------------------------------------"
Write-Host ("Detail complet enregistre dans : {0}" -f $OutputFile)
