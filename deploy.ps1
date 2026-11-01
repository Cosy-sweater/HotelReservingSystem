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
docker stack deploy -c compose.yaml hotel_cluster

Write-Host "=== [4/4] Verifying Cluster Services & Replicas ===" -ForegroundColor Cyan
Start-Sleep -Seconds 5
docker stack services hotel_cluster
docker network ls --filter driver=overlay