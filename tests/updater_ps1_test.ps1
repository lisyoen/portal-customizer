# Windows update helper test (run on a Windows PC, Windows PowerShell 5.1).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\updater_ps1_test.ps1 -HostPs1 updater\host.ps1 -BaseUrl http://server:port
# BaseUrl must serve /ext/portal-customizer-v9.9.10.zip (manifest version 9.9.10).
# Keep this file ASCII only.
param([Parameter(Mandatory = $true)][string]$HostPs1, [Parameter(Mandatory = $true)][string]$BaseUrl)
$ErrorActionPreference = 'Stop'
$fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Output "PASS $Name" } else { Write-Output "FAIL $Name $Detail"; $script:fail++ }
}
function New-Folder([string]$Version) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('pc-ps1-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $root 'updater') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'manifest.json') -Value ('{"manifest_version":3,"version":"' + $Version + '"}') -Encoding ASCII
    Copy-Item -LiteralPath $HostPs1 -Destination (Join-Path $root 'updater\host.ps1')
    return $root
}
function Invoke-Host([string]$Root, [hashtable]$Message, [hashtable]$Env = @{}) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'updater\host.ps1') + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[$k] = $Env[$k] }
    $p = [System.Diagnostics.Process]::Start($psi)
    $payload = [Text.Encoding]::UTF8.GetBytes(($Message | ConvertTo-Json -Compress))
    $len = [BitConverter]::GetBytes([int]$payload.Length)
    $p.StandardInput.BaseStream.Write($len, 0, 4)
    $p.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
    $p.StandardInput.Close()
    $out = $p.StandardOutput.BaseStream
    $ms = New-Object IO.MemoryStream
    $out.CopyTo($ms)
    $p.WaitForExit()
    $bytes = $ms.ToArray()
    if ($bytes.Length -lt 4) { return @{ ok = $false; message = 'no response' } }
    return ([Text.Encoding]::UTF8.GetString($bytes, 4, $bytes.Length - 4) | ConvertFrom-Json)
}
function Version-Of([string]$Root) { return [string]((Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json).version) }

$noGithub = @{ PC_LATEST_URL = 'http://127.0.0.1:9/none'; PC_DOWNLOAD_BASE = 'http://127.0.0.1:9' }

# 1) admin server package address is used (GitHub is not reachable here)
$r1 = New-Folder '0.0.1'
$res = Invoke-Host $r1 @{ action = 'update'; version = '9.9.10'; zipUrl = "$BaseUrl/ext/portal-customizer-v9.9.10.zip" } $noGithub
Check 'downloads the package from the given address' ($res.ok -and (Version-Of $r1) -eq '9.9.10' -and (Test-Path (Join-Path $r1 'updater\host.ps1'))) ($res | ConvertTo-Json -Compress)

# 2) only http/https addresses are accepted
$r2 = New-Folder '0.0.1'
$res = Invoke-Host $r2 @{ action = 'update'; version = '9.9.10'; zipUrl = 'file:///C:/Windows/win.ini' } $noGithub
Check 'rejects a non-http package address' ((-not $res.ok) -and ([string]$res.message) -like 'Invalid package address*' -and (Version-Of $r2) -eq '0.0.1') ($res | ConvertTo-Json -Compress)

# 3) a missing package keeps the current version
$r3 = New-Folder '0.0.1'
$res = Invoke-Host $r3 @{ action = 'update'; version = '9.9.11'; zipUrl = "$BaseUrl/ext/portal-customizer-v9.9.11.zip" } $noGithub
Check 'a missing package fails and keeps the current files' ((-not $res.ok) -and (Version-Of $r3) -eq '0.0.1') ($res | ConvertTo-Json -Compress)

foreach ($d in @($r1, $r2, $r3)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output ("{0}" -f $(if ($fail) { "FAILED $fail" } else { 'ALL PASS' }))
exit $fail
