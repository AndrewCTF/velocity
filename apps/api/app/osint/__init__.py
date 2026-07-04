"""Digital-OSINT infra/domain intelligence — keyless connectors + investigate.

The cyber/infrastructure OSINT domain (DNS, WHOIS/RDAP, cert transparency,
IP-geo, Shodan InternetDB, AlienVault OTX threat-intel) the geospatial platform
lacked. Connectors are pure keyless lookups (``connectors.py``); the investigate
orchestrator (``routes/osint.py``) fans them out and mints the results as
Object/Link rows into the existing per-user ontology (``intel/ontology.py``), so
they render through the existing InvestigationCanvas + entity cards unchanged.

Deferred (see the plan): person/identity connectors (username/email/breach) and
the optional GPL deep-recon sidecar (SpiderFoot/theHarvester/Amass).
"""
