# osint-recon sidecar

Optional deep-recon service for the OSINT console. It wraps the **GPL** recon
tools as subprocesses so their code never links into the MIT app — the app only
ever speaks HTTP to this process and receives normalised JSON.

| Tool | License | What it adds |
|------|---------|--------------|
| [Amass](https://github.com/owasp-amass/amass) | Apache-2 | deep subdomain enumeration |
| [theHarvester](https://github.com/laramies/theHarvester) | GPLv2 | emails + subdomains from 54+ sources |
| [SpiderFoot](https://github.com/smicallef/spiderfoot) | GPLv3 | 200+ module automated footprint |

## Run

```bash
# install whichever tools you want available (they're independent):
#   go install -v github.com/owasp-amass/amass/v4/...@master
#   pipx install theHarvester
#   git clone https://github.com/smicallef/spiderfoot && ...
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8099
```

Then point the app at it:

```bash
# apps/api/.env
OSINT_RECON_SIDECAR_URL=http://127.0.0.1:8099
```

With that set, `POST /api/osint/recon {target, tool}` on the main API proxies
here, and the discovered subdomains / IPs / emails are minted into the ontology
graph and linked to the target domain — same objects the keyless investigate
produces, so they render in the same Investigation canvas. Leave the env unset
and the recon feature is invisible (the endpoint returns 503).

## Endpoints

- `GET /health` → `{ok, tools: {amass, theharvester, spiderfoot: bool}}`
- `POST /recon {target, tool, timeout}` → `{subdomains[], emails[], ips[], hosts[]}`

Targets are validated as a domain/IP and tools are exec'd with an argument list
(never a shell string), so a target can't inject a command.

## Parser self-check (no tools required)

```bash
python server.py   # runs the parser assertions, prints "parser self-check OK"
```
