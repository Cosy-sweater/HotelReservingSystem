# deploy.ps1 - One-Click Cluster Build & Deployment
Write-Host "=== [0/4] Stopping any conflicting 'docker compose' containers ===" -ForegroundColor Yellow
docker compose down --remove-orphans 2>$null

Write-Host "=== [1/4] Building Microservice Docker Images ===" -ForegroundColor Cyan
docker build -t hotel-auth-service:latest ./auth-service
docker build -t hotel-backend:latest ./backend
docker build -t hotel-gateway:latest ./gateway

Write-Host "=== [2/4] Initializing Docker Swarm Cluster ===" -ForegroundColor Cyan
$swarmStatus = docker info --format '{{.Swarm.LocalNodeState}}'
if ($swarmStatus -ne "active") {
    docker swarm init
} else {
    Write-Host "Swarm cluster is already active." -ForegroundColor Green
}

Write-Host "=== [3/4] Deploying 5-Service Stack with Network Isolation ===" -ForegroundColor Cyan
docker stack deploy --resolve-image=never -c compose.yaml hotel_cluster

Write-Host "=== [4/4] Waiting for Cluster Replicas to Start ===" -ForegroundColor Cyan
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 2
    $services = docker stack services hotel_cluster --format "{{.Name}}: {{.Replicas}}"
    Write-Host "Status check ($i/12):" -ForegroundColor Gray
    $services | ForEach-Object { Write-Host "  $_" }
    if (($services -join " ") -notmatch "0/") {
        Write-Host "`nCluster is LIVE at http://localhost:8080" -ForegroundColor Green
        break
    }
}
docker stack services hotel_cluster