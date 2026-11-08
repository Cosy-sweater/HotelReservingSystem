Write-Host "Используем пользователя БД: $env:POSTGRES_POSTGRES_PASSWORD" -ForegroundColor Gray

$ErrorActionPreference = "Stop"
$StackName = "hotel_cluster"

Write-Host "=== [0/5] Preparing Environment & Stopping Conflicts ===" -ForegroundColor Yellow

if (-not (Test-Path ".env")) {
    Write-Host "Файл .env не найден. Создаю базовый .env..." -ForegroundColor DarkYellow
    @"
POSTGRES_USER=hotel_admin
POSTGRES_PASSWORD=db_secret_password
POSTGRES_DB=hotel_db
"@ | Set-Content ".env" -Encoding UTF8
}

Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $parts = $line -split "=", 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
}

try {
    $ImageTag = (git rev-parse --short HEAD 2>$null).Trim()
    if (-not $ImageTag) { throw "No git" }
} catch {
    $ImageTag = Get-Date -Format "yyyyMMdd-HHmmss"
}
$env:IMAGE_TAG = $ImageTag
Write-Host "Используется тег сборки IMAGE_TAG: $ImageTag" -ForegroundColor Gray

docker compose down --remove-orphans


Write-Host "`n=== [1/5] Building Microservice Docker Images ===" -ForegroundColor Cyan
$servicesToBuild = @("auth-service", "backend", "gateway")
foreach ($svc in $servicesToBuild) {
    Write-Host "Сборка hotel-$svc ($ImageTag)..." -ForegroundColor Gray
    docker build -t "hotel-${svc}:${ImageTag}" -t "hotel-${svc}:latest" "./$svc"
    if ($LASTEXITCODE -ne 0) { throw "Ошибка при сборке образа hotel-$svc" }
}


Write-Host "`n=== [2/5] Initializing Docker Swarm Cluster ===" -ForegroundColor Cyan
$swarmStatus = docker info --format '{{.Swarm.LocalNodeState}}' 2>$null
if ($swarmStatus -ne "active") {
    docker swarm init
    if ($LASTEXITCODE -ne 0) {
        docker swarm init --advertise-addr 127.0.0.1
    }
} else {
    Write-Host "Swarm cluster is already active." -ForegroundColor Green
}


Write-Host "`n=== [3/5] Deploying Stack to Docker Swarm ===" -ForegroundColor Cyan
docker stack deploy --resolve-image=never --prune -c compose.yaml $StackName
if ($LASTEXITCODE -ne 0) {
    throw "Ошибка при деплое стека $StackName в Docker Swarm!"
}


Write-Host "`n=== [4/5] Waiting for Cluster Replicas ===" -ForegroundColor Cyan
$maxAttempts = 20
$allReady = $false

for ($i = 1; $i -le $maxAttempts; $i++) {
    Start-Sleep -Seconds 2
    $serviceLines = docker stack services $StackName --format "{{.Name}}|{{.Replicas}}"
    Write-Host "Status check ($i/$maxAttempts):" -ForegroundColor Gray

    $pendingCount = 0
    foreach ($line in $serviceLines) {
        $parts = $line -split "\|"
        $svcName = $parts[0]
        $replicas = $parts[1]
        Write-Host "  ${svcName}: $replicas"

        $repParts = $replicas -split "/"
        if ($repParts[0] -ne $repParts[1] -or $repParts[1] -eq "0") {
            $pendingCount++
        }
    }

    if ($pendingCount -eq 0 -and $serviceLines.Count -gt 0) {
        $allReady = $true
        break
    }
}


Write-Host "`n=== [5/5] Verifying Gateway HTTP Response ===" -ForegroundColor Cyan
if ($allReady) {
    Write-Host "`nCluster is LIVE at http://localhost:8080" -ForegroundColor Green
} else {
    Write-Host "`nВНИМАНИЕ: Не все реплики успели запуститься за отведенное время." -ForegroundColor Yellow
    Write-Host "Статус задач кластера:" -ForegroundColor Yellow
    docker stack ps $StackName --no-trunc
}

docker stack services $StackName