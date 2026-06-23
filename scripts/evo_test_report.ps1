# evo_test_report.ps1 - Essaye plusieurs formats de parametres
# pour trouver lequel renvoie des donnees pour le rapport 100000012.
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

$today_iso = Get-Date -Format "yyyy-MM-dd"
$today_fr  = Get-Date -Format "dd/MM/yyyy"
$yesterday_iso = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
$yesterday_fr  = (Get-Date).AddDays(-1).ToString("dd/MM/yyyy")
$lastweek_iso  = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
$lastmonth_iso = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd")

$tests = @()

# Test A : IDs = -1 (signifie "tous" dans beaucoup d'API Evolution)
# Dates ISO aujourd'hui, heures 00:00:00 / 23:59:59
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="-1"},
    @{Name="idcampa";  Value="-1"},
    @{Name="idsegm";   Value="-1"},
    @{Name="idagent";  Value="-1"},
    @{Name="idfinal";  Value="-1"},
    @{Name="fdesde";   Value=$today_iso},
    @{Name="fhasta";   Value=$today_iso},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value="-1"}
) "A_IDs_moins1_dates_ISO_today"

# Test B : IDs = 0
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="0"},
    @{Name="idcampa";  Value="0"},
    @{Name="idsegm";   Value="0"},
    @{Name="idagent";  Value="0"},
    @{Name="idfinal";  Value="0"},
    @{Name="fdesde";   Value=$today_iso},
    @{Name="fhasta";   Value=$today_iso},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value="0"}
) "B_IDs_zero_dates_ISO_today"

# Test C : IDs = chaine vide
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value=""},
    @{Name="idcampa";  Value=""},
    @{Name="idsegm";   Value=""},
    @{Name="idagent";  Value=""},
    @{Name="idfinal";  Value=""},
    @{Name="fdesde";   Value=$today_iso},
    @{Name="fhasta";   Value=$today_iso},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value=""}
) "C_IDs_vides_dates_ISO_today"

# Test D : IDs = -1, dates au format francais
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="-1"},
    @{Name="idcampa";  Value="-1"},
    @{Name="idsegm";   Value="-1"},
    @{Name="idagent";  Value="-1"},
    @{Name="idfinal";  Value="-1"},
    @{Name="fdesde";   Value=$today_fr},
    @{Name="fhasta";   Value=$today_fr},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value="-1"}
) "D_IDs_moins1_dates_FR_today"

# Test E : IDs = -1, periode = hier (au cas ou pas de donnees aujourd'hui)
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="-1"},
    @{Name="idcampa";  Value="-1"},
    @{Name="idsegm";   Value="-1"},
    @{Name="idagent";  Value="-1"},
    @{Name="idfinal";  Value="-1"},
    @{Name="fdesde";   Value=$yesterday_iso},
    @{Name="fhasta";   Value=$yesterday_iso},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value="-1"}
) "E_IDs_moins1_dates_ISO_yesterday"

# Test F : IDs = -1, periode = 7 derniers jours
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="-1"},
    @{Name="idcampa";  Value="-1"},
    @{Name="idsegm";   Value="-1"},
    @{Name="idagent";  Value="-1"},
    @{Name="idfinal";  Value="-1"},
    @{Name="fdesde";   Value=$lastweek_iso},
    @{Name="fhasta";   Value=$today_iso},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value="-1"}
) "F_IDs_moins1_dates_ISO_lastweek"

# Test G : IDs = -1, periode = 30 derniers jours
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="-1"},
    @{Name="idcampa";  Value="-1"},
    @{Name="idsegm";   Value="-1"},
    @{Name="idagent";  Value="-1"},
    @{Name="idfinal";  Value="-1"},
    @{Name="fdesde";   Value=$lastmonth_iso},
    @{Name="fhasta";   Value=$today_iso},
    @{Name="hdesde";   Value="00:00:00"},
    @{Name="hhasta";   Value="23:59:59"},
    @{Name="transorg"; Value="-1"}
) "G_IDs_moins1_dates_ISO_lastmonth"

# Test H : IDs = -1, heures format court HH:mm
$tests += Invoke-EvoReport 100000012 @(
    @{Name="idsvc";    Value="-1"},
    @{Name="idcampa";  Value="-1"},
    @{Name="idsegm";   Value="-1"},
    @{Name="idagent";  Value="-1"},
    @{Name="idfinal";  Value="-1"},
    @{Name="fdesde";   Value=$today_iso},
    @{Name="fhasta";   Value=$today_iso},
    @{Name="hdesde";   Value="00:00"},
    @{Name="hhasta";   Value="23:59"},
    @{Name="transorg"; Value="-1"}
) "H_IDs_moins1_hours_short"

$tests | ConvertTo-Json -Depth 12 | Out-File -FilePath $OutputFile -Encoding UTF8
Write-Host ""
Write-Host ("Resultat enregistre dans : {0}" -f $OutputFile)
