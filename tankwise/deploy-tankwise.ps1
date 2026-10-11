param(
    [string]$StackName = 'tankwise-hackathon',
    [string]$Region = 'ap-south-1'
)

$ErrorActionPreference = 'Stop'

function Assert-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. Install it, reopen PowerShell, and retry."
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    & $Name @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $Name $($Arguments -join ' ')"
    }
}

if (-not (Test-Path 'template.yaml') -or -not (Test-Path 'frontend/package.json')) {
    throw 'Run this script from the Tankwise project root (the folder containing template.yaml).'
}

Assert-Command 'aws'
Assert-Command 'sam'
Assert-Command 'python'
Assert-Command 'npm'

Write-Host "Checking AWS authentication in region $Region..." -ForegroundColor Cyan
$identityJson = & aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) {
    throw 'AWS authentication failed. Run aws configure or aws sso login, then retry. Do not paste credentials into this script or chat.'
}
$identity = $identityJson | ConvertFrom-Json
Write-Host "Authenticated AWS account: $($identity.Account)" -ForegroundColor Green
Write-Host "Deploying stack '$StackName' in '$Region'. Review the SAM changeset before confirming." -ForegroundColor Cyan

Invoke-Checked 'sam' @('validate', '--lint')
Invoke-Checked 'sam' @('build')
Invoke-Checked 'sam' @('deploy', '--guided', '--stack-name', $StackName, '--region', $Region)

Write-Host 'Reading deployed CloudFormation outputs...' -ForegroundColor Cyan
$outputJson = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query 'Stacks[0].Outputs' --output json
if ($LASTEXITCODE -ne 0) {
    throw "Could not read outputs for stack '$StackName'. Check AWS CloudFormation in region $Region."
}
$outputs = $outputJson | ConvertFrom-Json
$apiOutput = $outputs | Where-Object { $_.OutputKey -eq 'TankwiseApiUrl' } | Select-Object -First 1
$healthOutput = $outputs | Where-Object { $_.OutputKey -eq 'TankwiseHealthUrl' } | Select-Object -First 1
if (-not $apiOutput -or -not $healthOutput) {
    throw 'Deployment returned no TankwiseApiUrl or TankwiseHealthUrl. Inspect the CloudFormation stack outputs.'
}

Write-Host "Checking real health endpoint: $($healthOutput.OutputValue)" -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri $healthOutput.OutputValue -Method Get -TimeoutSec 15
} catch {
    throw "Health endpoint request failed: $($_.Exception.Message). Inspect Lambda logs and API Gateway."
}
if ($health.status -ne 'ok' -or $health.storage -ne 'dynamodb') {
    throw "AWS was deployed, but the health check did not confirm DynamoDB. Response: $($health | ConvertTo-Json -Compress). Do not claim the AWS save path is verified yet."
}

$envContent = "VITE_API_BASE_URL=$($apiOutput.OutputValue)"
Set-Content -Path 'frontend/.env.local' -Value $envContent -Encoding ascii
Write-Host 'DynamoDB health check passed. frontend/.env.local has been written (it is gitignored).' -ForegroundColor Green

Push-Location 'frontend'
try {
    Invoke-Checked 'npm' @('install')
    Invoke-Checked 'npm' @('test')
    Invoke-Checked 'npm' @('run', 'build')
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'DEPLOYMENT AND HEALTH CHECK VERIFIED' -ForegroundColor Green
Write-Host "API: $($apiOutput.OutputValue)"
Write-Host "Health: $($healthOutput.OutputValue)"
Write-Host "DynamoDB table: $(($outputs | Where-Object { $_.OutputKey -eq 'WaterPlanTableName' } | Select-Object -First 1).OutputValue)"
Write-Host ''
Write-Host 'Next: run `cd frontend` then `npm run dev`. In Tankwise, verify the header says AWS + DynamoDB connected, save a decision, and verify it appears in DynamoDB history.' -ForegroundColor Yellow
Write-Host 'After judging, delete the billable stack with: sam delete --stack-name <stack-name> --region <region>' -ForegroundColor Yellow
