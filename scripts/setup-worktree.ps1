# Cria a junction .agents/skills -> .claude/skills neste checkout, se faltar.
# Idempotente: seguro rodar de novo (inclusive toda vez que abre uma worktree nova).
# Uso: powershell -File scripts\setup-worktree.ps1

$ErrorActionPreference = "Stop"

$root = git rev-parse --show-toplevel
if (-not $root) {
    Write-Error "Rode este script de dentro de um checkout git do Olume Chat."
    exit 1
}
$root = $root -replace "/", "\"

$target = Join-Path $root ".claude\skills"
$linkDir = Join-Path $root ".agents"
$link = Join-Path $linkDir "skills"

if (-not (Test-Path $target)) {
    Write-Error "Nao encontrei $target - este checkout nao tem as skills do projeto."
    exit 1
}

if (Test-Path $link) {
    Write-Host "Junction ja existe: $link"
    exit 0
}

New-Item -ItemType Directory -Force -Path $linkDir | Out-Null
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "Junction criada: $link -> $target"
