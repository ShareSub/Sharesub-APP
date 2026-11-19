param([ValidateSet('windows','android','all')][string]$Platform = 'all')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$cache = New-Item -ItemType Directory -Force (Join-Path $env:LOCALAPPDATA 'ShareSubVPNBuild')

function Fetch-Package($repository, $name, $sha) {
    $zip = Join-Path $cache.FullName $name
    if ((Test-Path -LiteralPath $zip) -and (Get-FileHash -LiteralPath $zip).Hash -eq $sha) { return $zip }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/tags/v26.11.9"
    $asset = $release.assets | Where-Object name -eq $name | Select-Object -First 1
    if (!$asset) { throw "GitHub release is missing $name" }
    $url = $asset.url + '?download=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    & curl.exe -fLsS --retry 2 --connect-timeout 15 --max-time 120 -H 'Accept: application/octet-stream' -o $zip $url
    if ($LASTEXITCODE -or (Get-FileHash -LiteralPath $zip).Hash -ne $sha) { throw "SHA-256 check failed for $name" }
    return $zip
}

if ($Platform -in @('windows', 'all')) {
    $zip = Fetch-Package 'XTLS/Xray-core' 'Xray-windows-64.zip' '1262522266337B824F07BEB8E1375786B437683B3890105469088F8E17E0A69D'
    $dir = New-Item -ItemType Directory -Force (Join-Path $root 'vendor/windows')
    & tar.exe -xf $zip -C $dir.FullName xray.exe wintun.dll LICENSE LICENSE-Wintun geosite.dat geoip.dat
    if ($LASTEXITCODE) { throw 'Could not extract Xray for Windows.' }
}
if ($Platform -in @('android', 'all')) {
    $zip = Fetch-Package 'XTLS/libXray' 'libxray-android.zip' '1B1AA12124A7112AF983A6CEA74C77F27AADC6B650ACF3C5A57019619BA9FA48'
    $dir = New-Item -ItemType Directory -Force (Join-Path $root 'vendor/android')
    & tar.exe -xf $zip -C $dir.FullName --strip-components 1 libxray-android/libXray.aar
    if ($LASTEXITCODE) { throw 'Could not extract libXray for Android.' }
    $notices = New-Item -ItemType Directory -Force (Join-Path $dir.FullName 'notices/licenses')
    foreach ($repository in @('libXray', 'Xray-core')) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/XTLS/$repository/v26.11.9/LICENSE" -OutFile (Join-Path $notices.FullName "$repository.txt")
    }
    $geo = New-Item -ItemType Directory -Force (Join-Path $dir.FullName 'geodata')
    $geoZip = Fetch-Package 'XTLS/Xray-core' 'Xray-windows-64.zip' '1262522266337B824F07BEB8E1375786B437683B3890105469088F8E17E0A69D'
    & tar.exe -xf $geoZip -C $geo.FullName geoip.dat geosite.dat
    if ($LASTEXITCODE) { throw 'Could not extract Xray GeoIP and GeoSite data.' }
}
