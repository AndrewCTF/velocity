# Disclaimer

**Velocity is provided as-is, with no warranty. You use it, and everything it
collects, entirely at your own risk.**

Read this before you run the platform, point it at an upstream, or rely on
anything it shows you.

## No warranty, no liability

This software is distributed under the [AGPL-3.0-or-later](./LICENSE), whose
Sections 15–17 govern and are restated here in plain terms: the software comes
with **absolutely no warranty** of any kind, express or implied, including
merchantability, fitness for a particular purpose, and non-infringement.

**The authors and contributors accept no responsibility or liability for any
use of this software or of the data it retrieves** — including how you collect
data, what you collect, what you do with it, and any direct, indirect,
incidental, or consequential damages, data loss, service suspension, account
termination, legal claim, or regulatory action arising from that use.

You are the operator. Every request this software sends is **your** request,
from your infrastructure, under your IP address, in your legal jurisdiction.
Responsibility for it is yours alone.

## Data collection, scraping, and upstream terms

Velocity aggregates public data from many third-party sources. Some are
documented public APIs. **Others are fetched by scraping or by browser-emulating
sidecars** that send origin/referer headers to retrieve data an ordinary browser
would receive — including, at various times, ADS-B aggregators, AIS providers,
and assorted web sources.

Consequences you accept by running it:

- **No upstream has authorised this project.** No endorsement, partnership, or
  permission is claimed or implied by any source named in [`NOTICE`](./NOTICE)
  or anywhere in this repository.
- **Each upstream carries its own licence and terms of service, and those terms
  bind you, not this project.** Several are non-commercial or academic-only
  (ACLED, OpenSky, community ADS-B feeds, and others). The AGPL covers this
  repository's *source code* and relicenses no upstream data whatsoever.
- **Scraping may breach a source's terms of service, and terms change without
  notice.** Verify each upstream's *current* terms yourself before you rely on
  it, and before any commercial or redistributive use. That a connector exists
  here is not advice that using it is lawful or permitted for you.
- **Rate limits, blocks, bans, and legal demands are yours to absorb.** Default
  cadences are tuned to be polite, not to guarantee compliance with any
  upstream's policy.
- Depending on where you are, automated collection may implicate computer-misuse,
  contract, copyright, database, or data-protection law. **If you are unsure,
  get your own legal advice.** Nothing here is legal advice.

## Personal data

Public feeds carry information about identifiable people — vessel and aircraft
operators, station owners, facility contacts, individuals named in news and
conflict reporting. Reference datasets bundled in this repo are scrubbed of
contact addresses on a best-effort basis, and that is **not** a compliance
control.

If you process personal data with this software, **you are the data controller**
under the GDPR, the UK GDPR, and comparable regimes, and the obligations —
lawful basis, minimisation, retention, subject rights — fall on you.

## Accuracy and fitness

The data is **frequently incomplete, delayed, spoofed, or simply wrong.**
Aircraft and vessel transponders can be falsified or switched off; feeds gap
without warning; conflict and hazard reporting is contested and revised;
AI-generated summaries in this platform **can be confidently incorrect** and are
not a substitute for a human analyst reading the source.

**This is not certified for safety-of-life, navigation, air traffic control,
emergency response, or any operational use where being wrong hurts someone.**
It is not a targeting system. Do not use it as the sole basis for a decision
affecting a person's safety, liberty, or rights.

## Prohibited use

Do not use this software to stalk, harass, surveil, dox, or target any
individual or group; to violate anyone's privacy or human rights; or to break
any applicable law, sanction, or export control. If that describes your use
case, you do not have permission to use this project.

## Reporting

Found personal data in this repository that should not be here, or a connector
that breaches an upstream's terms? Open an issue and it will be removed —
[github.com/AndrewCTF/velocity/issues](https://github.com/AndrewCTF/velocity/issues).
