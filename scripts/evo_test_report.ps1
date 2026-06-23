<#
  evo_test_report.ps1 — Lance un rapport Evolution et affiche la réponse pour analyse.

  Ce script est UNIQUEMENT pour tester. Il ne touche pas au tableau de bord.
  Il sert à découvrir la structure JSON que renvoient les rapports Evolution,
  pour que le module dashboard sache ensuite comment les afficher.

  COMMENT L'UTILISER
  1) Mets ce fichier dans C:\evo_push\ (à côté de evo_push.ps1)
  2) Ouvre PowerShell et lance :
        powershell -ExecutionPolicy Bypass -File "C:\evo_push\evo_test_report.ps1"
  3) Un fichier evo_test_report_output.json est créé dans le même dossier
  4) Ouvre-le avec le Bloc-notes et envoie-moi son contenu
#>

$EvoHost   = "evo1.ekiom.net"
$EvoLogin  = "NCADMIN"
$EvoPwd    = "NCADMIN"

# Rapport "Estado de listas (Camp)" = fichiers en cours / vierges / finalisés par campagne
# (parfait pour calculer fichiers vierges restants, taux de contact, taux de descente)
$ReportId  = 100000035

$OutputFile = Join-Path $PSScriptRoot "evo_test_report_output.json"

$ErrorActionPreference = "Stop"

$pair = "$($EvoLogin):$($EvoPwd)"
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $basicAuth"; Accept = "application/json"; "Content-Type" = "application/json" }

# Plage du jour
$today = Get-Date -Format "yyyy-MM-dd"
$body = @{
    Parameters = @(
        @{ Name = "fdesde"; Value = "$($today)T00:00:00" }
        @{ Name = "fhasta"; Value = "$($today)T23:59:59" }
    )
} | ConvertTo-Json -Depth 5

Write-Host "Test rapport $ReportId pour la période $today..."

try {
    $url = "https://$EvoHost/manager/api/v1/admin/reports/$ReportId/invoke?format=json"
    $resp = Invoke-WebRequest -Uri $url -Headers $headers -Method Post -Body $body -TimeoutSec 60
    $resp.Content | Out-File -FilePath $OutputFile -Encoding UTF8
    Write-Host "OK : réponse enregistrée dans $OutputFile"
    Write-Host "Taille : $($resp.Content.Length) caractères"
    Write-Host ""
    Write-Host "Aperçu des 500 premiers caractères :"
    Write-Host ($resp.Content.Substring(0, [Math]::Min(500, $resp.Content.Length)))
} catch {
    Write-Host "ERREUR : $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $errBody = $reader.ReadToEnd()
        Write-Host "Détail :"
        Write-Host $errBody
        $errBody | Out-File -FilePath $OutputFile -Encoding UTF8
    }
}
