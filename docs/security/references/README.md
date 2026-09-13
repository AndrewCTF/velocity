# Security references

These are the frameworks that `../gap-analysis-2026-09.md` is measured against. The PDFs are gitignored to
keep binaries out of history. Fetch them again with the URLs below and check each against its hash.

| Document | URL | sha256 |
| --- | --- | --- |
| NIST Cybersecurity Framework 2.0 (CSWP 29, 2024) | https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf | `3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c` |
| NIST SP 800-218 Secure Software Development Framework 1.1 | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf | `617746e553a9e2da49bfbd4eef0dfc3094758a39b869314e4173ac36605cde22` |
| OWASP Application Security Verification Standard 5.0.0 | https://github.com/OWASP/ASVS/raw/master/5.0/OWASP_Application_Security_Verification_Standard_5.0.0_en.pdf | `a2fa1bbe38f12cac86d3a0f0023327e9772201f65a7f741f282f5e785d268fc5` |
| ISO/IEC 27001:2022 Annex A | Copyrighted and sold by ISO (iso.org/standard/27001). Not stored here. | — |

ISO/IEC 27001:2022 is referenced by Annex A control number and title only.

```sh
cd docs/security/references
curl -4 -sSLO https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf
curl -4 -sSLO https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf
curl -4 -sSLO https://github.com/OWASP/ASVS/raw/master/5.0/OWASP_Application_Security_Verification_Standard_5.0.0_en.pdf
sha256sum -c <<'EOF'
3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c  NIST.CSWP.29.pdf
617746e553a9e2da49bfbd4eef0dfc3094758a39b869314e4173ac36605cde22  NIST.SP.800-218.pdf
a2fa1bbe38f12cac86d3a0f0023327e9772201f65a7f741f282f5e785d268fc5  OWASP_Application_Security_Verification_Standard_5.0.0_en.pdf
EOF
```
