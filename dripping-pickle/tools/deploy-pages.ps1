# Deploy the Loops site to GitHub Pages (CollectivusWorlds/loops).
#
# WHY THIS EXISTS: the source repo keeps its binaries in Git LFS, and GitHub
# Pages serves LFS POINTERS, not file content — a plain mirror push breaks
# every model and texture on the live site (found 2026-08-27: the personal
# Pages mirror had been serving 131-byte stubs since the LFS migration).
# So the deploy is a MATERIALIZED snapshot: the working tree's real bytes,
# committed to the public repo with no .gitattributes and therefore no LFS.
#
# It deploys the WORKING TREE as it stands (minus the exclusions below) —
# commit or stash anything you don't want on the public site first.
#
#   powershell -File tools/deploy-pages.ps1

$ErrorActionPreference = 'Stop'
$SRC    = Split-Path $PSScriptRoot -Parent
$DEPLOY = 'https://github.com/CollectivusWorlds/loops.git'
$TMP    = Join-Path $env:TEMP 'loops-pages-deploy'

$sha = (git -C $SRC rev-parse --short HEAD).Trim()

if (Test-Path $TMP) { Remove-Item $TMP -Recurse -Force }
# /XD dirs and /XF files never reach the public site. .gitattributes is the
# load-bearing exclusion: with it present, the fresh repo would re-convert
# every binary back into an LFS pointer on commit.
robocopy $SRC $TMP /MIR /XD .git node_modules /XF .gitattributes start-server.bat stop-server.bat | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

Push-Location $TMP
try {
  git init -b main -q
  git add -A
  git -c user.name='Loops Deploy' -c user.email='deploy@collectivusworlds' `
      commit -q -m "Deploy $sha"
  # One flat commit per deploy; the public repo carries no history worth keeping.
  git push --force $DEPLOY main:main
} finally { Pop-Location }

# Sanity: the pushed tree must contain real binaries, not pointers.
$probe = git -C $TMP cat-file -p "main:assets/cat/anim_idle_1.glb" 2>$null
if ($probe -and "$probe".StartsWith('version https://git-lfs')) {
  throw 'Deploy contains LFS pointers - .gitattributes exclusion failed'
}
Write-Host "Deployed $sha -> $DEPLOY (Pages: https://collectivusworlds.github.io/loops/)"
