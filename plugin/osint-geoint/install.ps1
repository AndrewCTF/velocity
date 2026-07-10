<#
.SYNOPSIS
    Ez-install the OSINT GEOINT MCP server into Claude Code - Windows.

.DESCRIPTION
    Prints the exact commands to register the OSINT GEOINT MCP server with
    Claude Code (full plugin, MCP-only CLI, or hosted HTTP). With -Run it also
    executes the Option-B 'claude mcp add' registration for you.

    (Linux/macOS: use plugin/osint-geoint/install.sh)

.PARAMETER Run
    Also register the MCP server now via 'claude mcp add' (needs the Claude Code
    CLI on PATH). Equivalent to install.sh's -y flag.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File plugin\osint-geoint\install.ps1
    Print the exact install commands.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File plugin\osint-geoint\install.ps1 -Run
    Also register the MCP server now.
#>
param([switch]$Run)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ASCII-only output below: a BOM-less .ps1 is decoded with the ANSI codepage on
# Windows PowerShell 5.1, so any non-ASCII source would mojibake at parse time.

$repo = (Get-Item $PSScriptRoot).Parent.Parent.FullName   # plugin\osint-geoint -> repo root
$py   = Join-Path $repo 'apps\api\.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }
$apiBase = if ($env:API_BASE) { $env:API_BASE } else { 'http://127.0.0.1:8000' }

Write-Host "OSINT repo:  $repo"
Write-Host "Python:      $py"
Write-Host "API base:    $apiBase"
Write-Host ""

Write-Host "== Option A - full plugin (MCP + skill + commands + agent) ================"
Write-Host "In Claude Code, run:"
Write-Host "    /plugin marketplace add $repo"
Write-Host "    /plugin install osint-geoint@osint-velocity"
Write-Host "  When prompted:  repo_dir = $repo   python = $py"
Write-Host ""
Write-Host "== Option B - MCP server only (Claude Code CLI) ==========================="
Write-Host "    claude mcp add osint-geoint ``"
Write-Host "        --env ""PYTHONPATH=$repo\apps\api"" ``"
Write-Host "        --env ""API_BASE=$apiBase"" ``"
Write-Host "        ""--"" ""$py"" -m app.mcp_server"
Write-Host "    (or just re-run this script with -Run, which registers it reliably)"
Write-Host ""
Write-Host "== Option C - hosted (no local backend; needs a Velocity token) ==========="
Write-Host "    claude mcp add --transport http osint-geoint ``"
Write-Host "        https://projectvelocity.org/mcp ``"
Write-Host "        --header ""Authorization: Bearer <VELOCITY_TOKEN>"""
Write-Host ""
Write-Host "NOTE: Options A/B query a LOCAL backend - start it first:  bash scripts/run-api.sh"
Write-Host "      (on Windows: run it under WSL, or launch the venv uvicorn directly)."

if ($Run -or $env:INSTALL_RUN -eq '1') {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        # Write-Host (not Write-Error) so the clean message shows and `exit 1`
        # actually runs under $ErrorActionPreference='Stop'.
        Write-Host "'claude' not on PATH - install the Claude Code CLI first." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "Registering the MCP server via 'claude mcp add'..."
    # Build an explicit argument array and splat it. PowerShell passes each
    # element to the native exe verbatim (including the literal '--'); do NOT
    # use the '--%' stop-parsing token - it would swallow the $py/$repo vars.
    $mcpArgs = @(
        'mcp', 'add', 'osint-geoint',
        '--env', "PYTHONPATH=$repo\apps\api",
        '--env', "API_BASE=$apiBase",
        '--', $py, '-m', 'app.mcp_server'
    )
    & claude @mcpArgs
    Write-Host "Done. Verify with:  claude mcp list"
}
