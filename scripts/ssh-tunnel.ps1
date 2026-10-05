<#
.SYNOPSIS
  Starts (or restarts) the SSH tunnel that exposes the remote 9Drive dev
  PostgreSQL and Redis on localhost.

.DESCRIPTION
  The dev databases live in Docker containers on the remote host and are bound
  to 127.0.0.1 there, so they are never exposed on the network. This script
  forwards:

      localhost:15432  ->  remote 127.0.0.1:15432   (PostgreSQL 16)
      localhost:16379  ->  remote 127.0.0.1:16379   (Redis 7)

  backend/.env already points at those local ports.

.EXAMPLE
  .\scripts\ssh-tunnel.ps1          # start if not running
  .\scripts\ssh-tunnel.ps1 -Restart # kill existing tunnel and start fresh
  .\scripts\ssh-tunnel.ps1 -Stop    # stop the tunnel
#>
[CmdletBinding()]
param(
  [switch]$Restart,
  [switch]$Stop,
  [string]$RemoteHost = 'sysuser@100.98.92.128',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\id_9drive')
)

$ErrorActionPreference = 'Stop'
$marker = '15432:127.0.0.1:15432'

function Get-TunnelProcesses {
  Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$marker*" }
}

if ($Stop -or $Restart) {
  Get-TunnelProcesses | ForEach-Object {
    Write-Host "Stopping tunnel pid $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}
if ($Stop) { exit 0 }

if (Get-TunnelProcesses) {
  Write-Host "Tunnel already running."
  exit 0
}

if (-not (Test-Path $KeyPath)) {
  throw "SSH key not found at $KeyPath. Generate it with: ssh-keygen -t ed25519 -f `"$KeyPath`" -N `'`'"
}

Start-Process -FilePath 'ssh.exe' -ArgumentList @(
  '-N', '-i', $KeyPath,
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-L', '15432:127.0.0.1:15432',
  '-L', '16379:127.0.0.1:16379',
  $RemoteHost
) -WindowStyle Hidden

Start-Sleep -Seconds 3

$pg = Test-NetConnection -ComputerName 127.0.0.1 -Port 15432 -WarningAction SilentlyContinue
$rd = Test-NetConnection -ComputerName 127.0.0.1 -Port 16379 -WarningAction SilentlyContinue

if ($pg.TcpTestSucceeded -and $rd.TcpTestSucceeded) {
  Write-Host "Tunnel up: postgres 127.0.0.1:15432, redis 127.0.0.1:16379"
} else {
  Write-Warning "Tunnel ports not reachable (postgres=$($pg.TcpTestSucceeded) redis=$($rd.TcpTestSucceeded)). Check the remote host and key."
  exit 1
}
