param([switch]$Unsigned)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (!$env:ANDROID_HOME -and (Test-Path "$env:USERPROFILE/.codex/android-sdk")) {
    $env:ANDROID_HOME = "$env:USERPROFILE/.codex/android-sdk"
}
$gradle = (Get-Command gradle -ErrorAction SilentlyContinue).Source
if (!$gradle) {
    $gradle = (Get-ChildItem "$env:USERPROFILE/.gradle/wrapper/dists/gradle-8.14-bin" -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if (!$gradle) { throw 'Install Gradle 8.14 and add it to PATH.' }
if (!(Test-Path (Join-Path $root 'vendor/android/libXray.aar')) -or
    !(Test-Path (Join-Path $root 'vendor/android/geodata/geoip.dat')) -or
    !(Test-Path (Join-Path $root 'vendor/android/geodata/geosite.dat'))) {
    & (Join-Path $PSScriptRoot 'fetch-core.ps1') android
}
$android = Join-Path $root 'android'
if ($Unsigned) {
    & $gradle --project-dir $android :app:assembleRelease
    exit $LASTEXITCODE
}
& $gradle --project-dir $android :app:assembleDebug
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$out = New-Item -ItemType Directory -Force (Join-Path $root 'dist')
$gradleFile = Get-Content -Raw (Join-Path $android 'app/build.gradle')
$version = [regex]::Match($gradleFile, "versionName '([^']+)'").Groups[1].Value
Copy-Item -LiteralPath (Join-Path $android 'app/build/outputs/apk/debug/app-debug.apk') -Destination (Join-Path $out.FullName "ShareSub-$version-Android.apk")
