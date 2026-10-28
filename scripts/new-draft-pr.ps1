param(
  [switch]$ValidateOnly,
  [string[]]$Paths,
  [string]$Title,
  [string]$Summary,
  [string]$Risks,
  [string]$CommitMessage,
  [int]$CheckTimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = 'rikumonsters-maker/test-project'
$root = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or (Resolve-Path $root).Path -ne (Resolve-Path (Join-Path $PSScriptRoot '..')).Path) { throw 'Run from the DaySync repository.' }
$branch = (git branch --show-current).Trim()
if (!$ValidateOnly -and $branch -notmatch '^feature/[a-zA-Z0-9._/-]+$') { throw 'Only feature branches can create PRs with this workflow.' }
if ((gh repo view --json nameWithOwner --jq .nameWithOwner).Trim() -ne $repo) { throw 'GitHub repository mismatch.' }
if ((git remote get-url origin).Trim() -ne 'https://github.com/rikumonsters-maker/test-project.git') { throw 'Git origin mismatch.' }
Push-Location $root
try {
  $tests = @(Get-ChildItem frontend -Filter '*.test.mjs' -File | ForEach-Object Name)
  if (!$tests.Count) { throw 'No Frontend tests found.' }
  Push-Location frontend
  try { & node --test @tests; if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' } }
  finally { Pop-Location }
  Push-Location backend
  try {
    & npm test; if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
    & npm run typecheck; if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
    $dryRun = Join-Path $env:TEMP "DaySync-PR-dry-run-$PID"
    & .\node_modules\.bin\wrangler.cmd deploy --dry-run --config wrangler.production.jsonc --outdir $dryRun
    if ($LASTEXITCODE -ne 0) { throw 'Worker dry-run failed.' }
  } finally { Pop-Location }
  if ($ValidateOnly) { Write-Output 'Validation passed. No commit, push, or PR was created.'; return }
  if (!$Paths -or !$Title -or !$Summary -or !$Risks -or !$CommitMessage) { throw 'Paths, Title, Summary, Risks, and CommitMessage are required.' }
  & git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Existing staged changes must be reviewed separately.' }
  foreach ($path in $Paths) {
    if ([IO.Path]::IsPathRooted($path) -or $path -match '(^|[\\/])\.\.?([\\/]|$)' -or
      $path -match '(^|[\\/])(\.local-legacy-archive|\.wrangler|node_modules|\.git)([\\/]|$)|(^|[\\/])(?:\.env|\.dev\.vars)|\.(?:sqlite|sqlite3|db|dpapi|pem|p12)$' -or
      (!(Test-Path -LiteralPath $path -PathType Leaf) -and !(git ls-files --error-unmatch -- $path 2>$null))) { throw "Unsafe or missing explicit file path: $path" }
  }
  & git add -- @Paths; if ($LASTEXITCODE -ne 0) { throw 'Git staging failed.' }
  & git diff --cached --check; if ($LASTEXITCODE -ne 0) { throw 'Staged diff has whitespace errors.' }
  $staged = @(git diff --cached --name-only)
  if (!$staged.Count) { throw 'No staged changes to commit.' }
  & node scripts/check-pr-safety.mjs --cached
  if ($LASTEXITCODE -ne 0) { throw 'Staged changes failed safety scan.' }
  $base = (git rev-parse origin/main).Trim()
  $head = (git rev-parse HEAD).Trim()
  & node scripts/check-pr-safety.mjs $base $head
  if ($LASTEXITCODE -ne 0) { throw 'Existing PR changes failed safety scan.' }
  & git commit -m $CommitMessage; if ($LASTEXITCODE -ne 0) { throw 'Commit failed.' }
  $head = (git rev-parse HEAD).Trim()
  & node scripts/check-pr-safety.mjs $base $head
  if ($LASTEXITCODE -ne 0) { throw 'Committed changes failed safety scan. Push was stopped.' }
  & git push --set-upstream origin $branch; if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
  $existingJson = gh pr list -R $repo --head $branch --state open --json number
  if ($existingJson.Trim() -ne '[]') { throw 'An open PR already exists for this branch; no duplicate was created.' }
  $frontendOnly = @((git diff --name-only "$base...$head") | Where-Object { $_ -notlike 'frontend/*' }).Count -eq 0
  $marker = if ($frontendOnly) { '<!-- DaySync automation: frontend-only -->' } else { '<!-- DaySync automation: manual backend gate -->' }
  $body = @"
$marker
## Changes
$Summary

## Verification
Frontend tests, Backend tests, TypeScript typecheck, and Worker dry-run passed. Head commit: $head

## Release risks
$Risks

## Release order
$(if ($frontendOnly) { 'Frontend only: after required checks and Vercel Preview pass, protected auto-merge allows the existing GitHub integration to deploy Production.' } else { 'Backend or settings changed: auto-merge is disabled. Verify D1 and Worker compatibility and release order separately.' })
"@
  $bodyFile = Join-Path $env:TEMP "DaySync-PR-$PID.md"
  try {
    [IO.File]::WriteAllText($bodyFile,$body,[Text.UTF8Encoding]::new($false))
    $url = (& gh pr create -R $repo --draft --base main --head $branch --title $Title --body-file $bodyFile)
    if ($LASTEXITCODE -ne 0) { throw 'Draft PR creation failed.' }
  } finally { Remove-Item -LiteralPath $bodyFile -ErrorAction SilentlyContinue }
  Write-Output "Draft PR: $url"
  $deadline = (Get-Date).AddSeconds($CheckTimeoutSeconds)
  do {
    $checks = gh pr checks $url -R $repo --json name,bucket | ConvertFrom-Json
    $failed = @($checks | Where-Object { $_.bucket -in @('fail','cancel') })
    if ($failed.Count) { throw 'GitHub or Vercel check failed; PR remains Draft.' }
    $required = @('day-sync-frontend','day-sync-backend','day-sync-security','Vercel')
    $passed = @($checks | Where-Object { $_.bucket -eq 'pass' } | ForEach-Object Name)
    if (@($required | Where-Object { $_ -notin $passed }).Count -eq 0) {
      $deployments = gh api "repos/$repo/deployments?sha=$head&per_page=20" | ConvertFrom-Json
      foreach ($deployment in @($deployments | Where-Object { $_.environment -eq 'Preview' -and $_.sha -eq $head })) {
        $statuses = gh api "repos/$repo/deployments/$($deployment.id)/statuses?per_page=1" | ConvertFrom-Json
        if ($statuses[0].state -eq 'success') { Write-Output "Preview READY: $($statuses[0].environment_url)"; Write-Output "Release gate: $(if ($frontendOnly) {'eligible for protected auto-merge'} else {'manual backend gate'})"; return }
      }
    }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)
  throw 'Checks or exact-commit Preview were not confirmed before timeout; PR remains Draft.'
} finally { Pop-Location }
