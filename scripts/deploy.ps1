# Deploy GymLog to your own Cloudflare account: token check -> tests -> build -> deploy -> verify.
# Usage:  powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -Url https://<your-worker>.workers.dev
# Prerequisites: wrangler logged in, a D1 database created and its id set in wrangler.toml,
# and the Worker secret set once with:  npx wrangler secret put SYNC_TOKEN
param([Parameter(Mandatory = $true)][string]$Url)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$secure = Read-Host 'Sync token (hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$headers = @{ Authorization = "Bearer $($token.Trim())" }

function Step($name, [scriptblock]$cmd) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "FAILED: $name (exit $LASTEXITCODE). Nothing after this step was run." }
}

try {
  # Only meaningful once the Worker is deployed with the same secret; skip on a first deploy.
  try { Invoke-RestMethod -Uri "$Url/api/sync/status" -Headers $headers | Out-Null; Write-Host 'Token accepted by the server.' }
  catch { Write-Warning 'Server did not accept the token (expected on a first deploy).' }
  Step 'npm test' { npm test }
  Step 'build' { npm run build }
  Step 'deploy' { npx wrangler deploy }
  Write-Host "`n=== verify ===" -ForegroundColor Cyan
  $status = Invoke-RestMethod -Uri "$Url/api/sync/status" -Headers $headers
  Write-Host ($status | ConvertTo-Json -Compress)
}
finally {
  Remove-Variable token, headers -ErrorAction SilentlyContinue
}
