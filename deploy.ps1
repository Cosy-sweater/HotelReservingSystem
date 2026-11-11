$ErrorActionPreference = "Stop"
$StackName = "hotel_cluster"

Write-Host "=== [1/4] Preparing environment ===" -ForegroundColor Cyan
if (-not (Test-Path ".env")) {
    "POSTGRES_USER=hotel_admin`nPOSTGRES_PASSWORD=db_secret_password`nPOSTGRES_DB=hotel_db" | Set-Content ".env" -Encoding UTF8
}

Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*([^#=\s]+)\s*=\s*(.*)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process")
    }
}

$gitSha = git rev-parse --short HEAD 2>$null
$env:IMAGE_TAG = if ($LASTEXITCODE -eq 0 -and $gitSha) { $gitSha.Trim() } else { Get-Date -Format "yyyyMMdd-HHmmss" }

docker compose down --remove-orphans 2>$null | Out-Null

Write-Host "=== [2/4] Building images ===" -ForegroundColor Cyan
foreach ($svc in @("auth-service", "backend", "gateway")) {
    Write-Host "  Building hotel-$svc..." -ForegroundColor Gray
    docker build -q -t "hotel-${svc}:$env:IMAGE_TAG" -t "hotel-${svc}:latest" "./$svc" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed for hotel-$svc" }
}

Write-Host "=== [3/4] Adding stack to swarm ===" -ForegroundColor Cyan
if ((docker info --format '{{.Swarm.LocalNodeState}}' 2>$null) -ne "active") {
    docker swarm init 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { docker swarm init --advertise-addr 127.0.0.1 | Out-Null }
}

docker stack deploy --resolve-image=never --prune -c compose.yaml $StackName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Stack deployment failed" }

Write-Host "=== [4/4] Waiting for replicas to start ===" -ForegroundColor Cyan
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 2
    $status = docker stack services $StackName --format "  {{.Name}}: {{.Replicas}}"
    Write-Host "Status check ($i/20):" -ForegroundColor Gray
    $status | Write-Host

    if ($status -and -not ($status -notmatch ':\s*([1-9]\d*)/\1$')) {
        Write-Host "`nCluster is LIVE at http://localhost:8080" -ForegroundColor Green
        exit 0
    }
}

Write-Host "`nWarning: Not all replicas started in time." -ForegroundColor Yellow
docker stack ps $StackName --no-trunc