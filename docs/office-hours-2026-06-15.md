# Office Hours Readout — OSINT Fusion Globe

_YC-style startup office-hours, 2026-06-15. Founder answered honestly; may be wrong, never lied._

## Diagnosis
This is a technically real, well-built tool with zero demand validation. It originated builder-first, not from a lived field problem — the fusion concept was a reaction to a critique that the layers were "gimmicks coexisting, not intelligence," not a pull from any analyst. The founder was honest enough to name the endpoint himself: closer to a "build because it's engaging" project than a startup. Nothing here is broken; the engineering is genuine and the adjacent problem (GPS jamming + ships going dark, fused into one incident view) is real and unserved by a free tool. But "real problem in the world" and "validated demand for this product" are different claims, and only the first is supported. There is no user, no outreach, no finding ever produced for real. Until a signal that isn't the founder's own enjoyment steers the work, this is a project.

## The Six Forcing Questions, Scored

1. **Demand reality — UNKNOWN.** Zero real users; nobody requested access but the founder. Adjacent demand (GPSJam, ADS-B Exchange, MarineTraffic, TankerTrackers, Bellingcat) is real but none of it has touched this product. Demand for *this* is an untested hypothesis.
2. **Origin — VALIDATED (and damning).** Builder-driven, not field-driven, by the founder's own admission. Fusion was a reaction to a critique, not a request from anyone who does the work.
3. **Status quo — INFERRED.** The pain (tab-juggling across single-domain tools, eyeball correlation, hours per incident) is plausible and consistently described — but never observed. No analyst has been shadowed.
4. **Who picks you over the incumbent — INFERRED.** The Palantir framing is wrong (those buyers won't adopt a $0 keyless tool). The real candidate is the non-consumer who can't get Palantir at all. Their incentives are inferred, not heard from a buyer.
5. **Narrowest payable wedge — INFERRED, with one hard signal.** A standing alert on a contested chokepoint (dark vessel under GPS jamming, cited) is a coherent atom. The supporting evidence is categorical, not product-level: maritime-risk/sanctions/insurance *already pays* for adjacent data.
6. **Keyless differentiator — UNKNOWN (founder reclassified to builder elegance).** No buyer has ever asked for keyless. Same verdict on the AI-agent-native/MCP angle — fashion pattern-matching, owned as such. Neither is a validated wedge.

## The Real Wedge
**Maritime dark-vessel / sanctions intelligence.** It is the only category in the analysis with a proven, paying market — Windward, Kpler, Lloyd's List Intelligence, and Spire all exist and sell exactly this. That is the signal worth following, and it is a signal about the *category*, not about this product. Narrow the entire bet to one chokepoint and one buyer type: a cited "dark vessel under GPS jamming" finding for a maritime-risk / sanctions-compliance analyst. Everything else in the globe is scaffolding around that one atom.

## The One Thing To Do This Week
Run one falsifiable experiment to produce the first non-founder signal. Cheapest artifact → one named recipient:

1. **Run the SAR detection for real, once.** It is route-validated but has never produced an actual finding (CDSE quota was the blocker). One real scene over Hormuz/Kerch/Bab-el-Mandeb. No real detection = nothing to send = no experiment.
2. **Name one recipient.** A single maritime-risk or sanctions-compliance analyst — by name, not a persona. This naming is the actual gap; the founder admitted outreach has never once been attempted, and the honest reason is preferring to build over selling plus fear the answer is "no one cares."
3. **Send a one-page "Strait Watch" brief.** "This week in [chokepoint]: N dark vessels under GPS jamming, cited with SAR scene dates + positions." Ask one question: *would this change what you do on Monday?*

The deliverable this week is not code. It is one email to one named human with one real finding attached.

## Kill Criteria
- **Walk away** if the named analyst (or the 2–3 you can reach) says it wouldn't change their workflow, OR if you cannot bring yourself to send the email at all. The second outcome is the more likely and more important result: not sending it *is* the answer, and it means this stays a personal project — which is fine, but call it that.
- **Continue** only if a real recipient reacts to a real finding with "send me next week's" or asks how to get it on a cadence. That pull — not the satisfaction of building — is the only thing that converts this from project to startup.

## What NOT To Build
No new features. No new layers, no new data sources, no new globe polish, no MCP server, no keyless-architecture work — none of it until one human being asks for one specific thing. Every hour spent building this week is an hour spent avoiding the experiment that actually de-risks the bet. The codebase is already past the point where more capability reduces uncertainty; only contact with a buyer does.

## Closing
The tool is real. The startup is not — yet. The cheapest way to find out which one this becomes costs one email, and you already know the reason it hasn't been sent. Send it this week or admit, cleanly, that you're building this because it's fun. Both are honest answers; drifting between them is the only losing move.
