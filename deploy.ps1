$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env")) {
    $randDbPass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
    @(
        "POSTGRES_USER=hotel_admin"
        "POSTGRES_DB=hotel_db"
        "POSTGRES_PASSWORD=$randDbPass"
        "ADMIN_INITIAL_PASSWORD=AdminPass2026!"
        "IMAGE_TAG=latest"
    ) | Set-Content ".env"
    Write-Host "Generated .env with secure random database password." -ForegroundColor Green
}

Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*([^#=]+)=(.*)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
    }
}

docker compose down --remove-orphans 2>$null

docker build -t "hotel-auth-service:$env:IMAGE_TAG" ./auth-service
docker build -t "hotel-backend:$env:IMAGE_TAG" ./backend
docker build -t "hotel-gateway:$env:IMAGE_TAG" ./gateway

$swarmStatus = docker info --format '{{.Swarm.LocalNodeState}}'
if ($swarmStatus -ne "active") {
    docker swarm init
}

docker stack deploy --resolve-image=never -c compose.yaml hotel_cluster
Start-Sleep -Seconds 5
docker stack services hotel_cluster