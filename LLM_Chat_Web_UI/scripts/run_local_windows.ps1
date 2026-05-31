$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendDir = Join-Path $RootDir "backend"
$FrontendDir = Join-Path $RootDir "frontend"
$AdminUser = if ($env:ADMIN_USER) { $env:ADMIN_USER } else { "admin" }
$AdminPassword = if ($env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD } else { "ChangeMe123!" }
$EnvFile = Join-Path $RootDir ".env"

if (!(Test-Path $EnvFile)) {
    Copy-Item (Join-Path $RootDir ".env.example") $EnvFile
}

$PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($PythonLauncher) {
    & py -3 -m venv (Join-Path $BackendDir ".venv")
} else {
    & python -m venv (Join-Path $BackendDir ".venv")
}

$BackendPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
& $BackendPython -m pip install -r (Join-Path $BackendDir "requirements.txt")
& $BackendPython (Join-Path $BackendDir "scripts\create_admin.py") $AdminUser $AdminPassword

if (!(Test-Path (Join-Path $FrontendDir "node_modules"))) {
    Push-Location $FrontendDir
    npm install
    Pop-Location
}

$Backend = Start-Process `
    -FilePath $BackendPython `
    -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
    -WorkingDirectory $BackendDir `
    -PassThru

$Npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
$Frontend = Start-Process `
    -FilePath $Npm `
    -ArgumentList @("run", "dev:lan", "--", "--port", "5173") `
    -WorkingDirectory $FrontendDir `
    -PassThru

Write-Host ""
Write-Host "Local URL: http://127.0.0.1:5173/"
Write-Host "Login:     $AdminUser / $AdminPassword"
Write-Host "Stop:      close this PowerShell window or press Ctrl+C"
Write-Host ""

try {
    Wait-Process -Id $Backend.Id, $Frontend.Id
} finally {
    Stop-Process -Id $Backend.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $Frontend.Id -ErrorAction SilentlyContinue
}
