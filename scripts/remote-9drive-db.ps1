<#
.SYNOPSIS
  Manage the remote 9Drive dev database containers over SSH.

.DESCRIPTION
  The dev PostgreSQL + Redis containers for 9Drive run in Docker on the remote
  host and are bound to 127.0.0.1 there (never exposed on the network). This
  wrapper pushes scripts/remote-create-db.sh over SSH and runs it.

  Local access goes through the tunnel created by scripts/ssh-tunnel.ps1:
      localhost:15432 -> remote PostgreSQL 16   (9drive / 9drive)
      localhost:16379 -> remote Redis 7

.EXAMPLE
  .\scripts\remote-9drive-db.ps1 -Action status
  .\scripts\remote-9drive-db.ps1 -Action recreate
  .\scripts\remote-9drive-db.ps1 -Action logs
  .\scripts\remote-9drive-db.ps1 -Action stop
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'recreate', 'start', 'stop', 'logs', 'psql', 'shell')]
  [string]$Action = 'status',
  [string]$RemoteHost = 'sysuser@100.98.92.128',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\id_9drive'),
  [string]$RemoteScript = '/tmp/9drive-create-db.sh'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$localScript = Join-Path $PSScriptRoot 'remote-create-db.sh'

$ssh = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')

switch ($Action) {
  'status' {
    & ssh @ssh $RemoteHost "docker ps -a --filter name=9drive --format '{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}'; echo '--- volumes ---'; docker volume ls --filter name=9drive --format '{{.Name}}'"
  }
  'recreate' {
    scp @('-i', $KeyPath, '-o', 'BatchMode=yes') $localScript "${RemoteHost}:${RemoteScript}"
    & ssh @ssh $RemoteHost "sed -i 's/\r$//' $RemoteScript && bash $RemoteScript"
    & (Join-Path $PSScriptRoot 'ssh-tunnel.ps1') -Restart
  }
  'start' {
    & ssh @ssh $RemoteHost "docker start 9drive-pg-dev 9drive-redis-dev; sleep 3; docker ps --filter name=9drive --format '{{.Names}}|{{.Status}}'"
    & (Join-Path $PSScriptRoot 'ssh-tunnel.ps1')
  }
  'stop' {
    & ssh @ssh $RemoteHost "docker stop 9drive-pg-dev 9drive-redis-dev"
    & (Join-Path $PSScriptRoot 'ssh-tunnel.ps1') -Stop
  }
  'logs' {
    & ssh @ssh $RemoteHost "docker logs --tail 100 9drive-pg-dev; echo '===== redis ====='; docker logs --tail 50 9drive-redis-dev"
  }
  'psql' {
    & ssh @ssh -t $RemoteHost "docker exec -it 9drive-pg-dev psql -U 9drive -d 9drive"
  }
  'shell' {
    & ssh @ssh -t $RemoteHost
  }
}
