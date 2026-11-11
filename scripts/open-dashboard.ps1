param([int]$Port = 3220)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$controllerDataDirectory = if ($env:CONTROLLER_DATA_DIR) { $env:CONTROLLER_DATA_DIR } else { Join-Path $projectDirectory 'data' }
$keyFile = Join-Path $controllerDataDirectory 'api-key.txt'
if (!(Test-Path -LiteralPath $keyFile)) { throw 'Start the controller first, then open the dashboard.' }
$controllerKey = [System.IO.File]::ReadAllText($keyFile).Trim()
if ($controllerKey -notmatch '^[a-f0-9]{64}$') { throw 'The controller management key is invalid.' }
if ($env:PORT) { $Port = [int]$env:PORT }
Start-Process -FilePath "http://127.0.0.1:$Port/#key=$controllerKey" -WindowStyle Hidden
