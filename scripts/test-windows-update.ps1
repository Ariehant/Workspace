# The Windows installer updates itself: build the current version and a newer one, serve the
# newer one as an update feed, install the older one silently, run it with --update-check, and
# check that the newer one was installed. Run from the repository root on Windows. Used by the
# release workflow.
#
#   pwsh scripts/test-windows-update.ps1 -App desktop|calendar
param([ValidateSet('desktop', 'calendar')][string]$App = 'desktop')
$ErrorActionPreference = 'Stop'

$config = @{
  desktop  = @{ Dir = 'apps/desktop'; Filter = '@workspace/desktop'; Exe = 'workspace-app.exe'
                FeedVar = 'WORKSPACE_UPDATE_URL'; DataVar = 'WORKSPACE_DATA_DIR'; Channel = 'latest' }
  calendar = @{ Dir = 'apps/calendar'; Filter = '@workspace/calendar'; Exe = 'workspace-calendar.exe'
                FeedVar = 'CALENDAR_UPDATE_URL'; DataVar = 'CALENDAR_DATA_DIR'; Channel = 'calendar' }
}[$App]

$work = Join-Path $env:RUNNER_TEMP "update-$App"
if (-not $env:RUNNER_TEMP) { $work = Join-Path ([IO.Path]::GetTempPath()) "update-$App" }
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$work/feed", "$work/data" | Out-Null

$current = node -p "require('./$($config.Dir)/package.json').version"
$newer = node -p "const [a, b, c] = '$current'.split('-')[0].split('.').map(Number); [a, b, c + 1].join('.')"

function Build([string]$out) {
  pnpm --filter $config.Filter exec electron-vite build | Out-Null
  Push-Location $config.Dir
  try {
    npx electron-builder --win nsis --publish never "--config.directories.output=$out" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}

Write-Host "${App}: building $current and $newer…"
Build "$work/current"
try {
  node scripts/version.mjs set $newer | Out-Null
  Build "$work/newer"
} finally {
  node scripts/version.mjs set $current | Out-Null
}
# The feed as the Release workflow publishes it, under the channel the current version follows
# (a release candidate's: rc, calendar-rc).
$track = $config.Channel
if ($current.Contains('-')) { $track = if ($App -eq 'desktop') { 'rc' } else { "$($config.Channel)-rc" } }
Copy-Item "$work/newer/*.exe", "$work/newer/*.exe.blockmap" "$work/feed/"
Copy-Item "$work/newer/$($config.Channel).yml" "$work/feed/$track.yml"

$port = Get-Random -Minimum 20000 -Maximum 40000
$server = Start-Process python -ArgumentList '-m', 'http.server', $port, '--bind', '127.0.0.1', '--directory', "$work/feed" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $setup = Get-ChildItem "$work/current/*.exe" | Select-Object -First 1
  Write-Host "Installing $($setup.Name) silently…"
  $install = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "The installer failed (exit code $($install.ExitCode))" }
  $exe = Get-ChildItem -Recurse -Filter $config.Exe "$env:LOCALAPPDATA\Programs" | Select-Object -First 1
  if (-not $exe) { throw "$($config.Exe) wasn't installed under $env:LOCALAPPDATA\Programs" }
  Write-Host "Installed: $($exe.FullName), version $($exe.VersionInfo.ProductVersion)"

  Write-Host "Running $current with an update feed…"
  Set-Item "env:$($config.FeedVar)" "http://127.0.0.1:$port/"
  Set-Item "env:$($config.DataVar)" "$work/data"
  $run = Start-Process -FilePath $exe.FullName -ArgumentList '--update-check' -Wait -PassThru
  if ($run.ExitCode -ne 0) { throw "--update-check failed (exit code $($run.ExitCode))" }

  # The app quit into the installer, which runs on its own: wait for the new version.
  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 3
    $got = (Get-Item $exe.FullName -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
  } until ($got -eq $newer -or (Get-Date) -gt $deadline)
  Write-Host "Installed now: version $got"
  if ($got -ne $newer) { throw "Expected $newer after the update, found $got" }
  Write-Host "${App}: Windows update ok"
} finally {
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
  # Leave the runner clean for the other app's test.
  $uninstall = Get-ChildItem -Recurse -Filter 'Uninstall*.exe' (Split-Path $exe.FullName) -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($uninstall) { Start-Process -FilePath $uninstall.FullName -ArgumentList '/S' -Wait | Out-Null }
}
