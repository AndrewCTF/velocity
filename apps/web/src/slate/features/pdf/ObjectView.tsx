// The selected object's view: header and tabs, then the Properties, Media, Map,
// Links and Related Artifacts cards. The Browser shows it beside its result
// list (light) and the custom object view shows it on its own (dark); `where`
// says which one, so each tab leads to the other when the card it names lives
// there.
import { Btn, Card, Ic, Kv, N_MEDIA, Sat, Ship, Tab, dash } from "./kit.js";
import {
  R_KM, TRK, chokesNear, dmy, hhmm, nProps, nearbyEvents, nearestPorts, nearestWarnings, title, unavailable,
} from "./data.js";
import { metresPerPx, project } from "./plate.js";
import type { Ctx } from "./model.js";

/** Link groups of the selected object. */
export function linksOf(c: Ctx) {
  const s = c.sel;
  if (!s) return { wl: [], alt: [], ports5: [], near6: [], chokes: [], lists: [] as string[] };
  const wl = nearestWarnings(c.warnings, s.v.lon, s.v.lat);
  const alt = nearbyEvents(c.alerts, s.v.lon, s.v.lat);
  const ports5 = nearestPorts(c.ports, s.v.lon, s.v.lat).map((p) => title(p.name));
  const near6 = c.list.filter((r) => r !== s).slice(0, 6);
  const chokes = chokesNear(c.chokes, s.v.lon, s.v.lat);
  return { wl, alt, ports5, near6, chokes, lists: c.sanc?.lists ?? [] };
}
export function sancLine(c: Ctx): string {
  if (!c.sanc) return unavailable("Sanctions lookup", c.sancRes);
  return `${c.sanc.lists.map((l) => l.replace("UN Security Council", "UN SC")).join(", ")}: ${c.sanc.matched ? "match" : "no match"}`;
}

const Group = ({ name, n, children }: { name: string; n: number; children: JSX.Element[] | JSX.Element | null }): JSX.Element => (
  <div className="pxo-grp">
    <h4><Ic n="chevron-down" s={12} /> {name} <span className="px-mu">({n})</span></h4>
    <ul className="pxo-items">{children}</ul>
  </div>
);

function LinksCard({ c, where }: { c: Ctx; where: "browser" | "cov" }): JSX.Element {
  const L = linksOf(c);
  const nEnt = L.near6.length + L.ports5.length + L.chokes.length + L.lists.length;
  const nAll = nEnt + L.alt.length + L.wl.length;
  const other = where === "browser" ? "cov" : "browser";
  return (
    <Card icon="link" title="Links" right={<span className="px-mu">{nEnt} Entities, {L.alt.length} Events, {L.wl.length} Documents</span>} className="pxo-links">
      <div className="pxo-scroll">
        {where === "browser" ? (
          <Group name="Document" n={L.wl.length}>
            {L.wl.map((w) => <li key={w}><Ic n="document" s={12} /> <span className="px-lk">{w}</span></li>)}
          </Group>
        ) : null}
        <Group name="Nearby events" n={L.alt.length}>
          {L.alt.map((w) => <li key={w}><Ic n="high-priority" s={12} /> <span className="px-lk">{w}</span></li>)}
        </Group>
        <Group name="Place" n={L.ports5.length}>
          {L.ports5.map((w) => <li key={w}><Ic n="geosearch" s={12} /> <span className="px-lk">{w}</span></li>)}
        </Group>
        <Group name="Sanctions lists" n={L.lists.length}>
          <li><Ic n="shield" s={12} /> <span className="px-lk">{sancLine(c)}</span></li>
        </Group>
        <Group name="Vessel" n={L.near6.length}>
          {L.near6.map((r) => (
            <li key={r.mmsi}>
              <button type="button" className="px-btn lnk" aria-label={`Open ${r.name}`} title={`Open ${r.name}`} onClick={() => c.pick(r.mmsi)}>
                <Ship s={12} /> {title(r.name)}
              </button>
            </li>
          ))}
        </Group>
        <div className="px-mu pxo-more">More object types</div>
        <Group name="Chokepoint" n={L.chokes.length}>
          {L.chokes.map((k) => <li key={k.name}><Ic n="waves" s={12} /> <span className="px-lk">{k.name}</span></li>)}
        </Group>
      </div>
      <footer className="pxo-foot">
        <Btn label={`View all links: the ${other === "cov" ? "custom object view" : "Browser"}`} icon="arrow-right" onClick={() => c.go(other)} className="lnk">View all {nAll}</Btn>
      </footer>
    </Card>
  );
}

function MapCard({ c, where }: { c: Ctx; where: "browser" | "cov" }): JSX.Element {
  const s = c.sel!;
  const z = 11;
  const ring = (R_KM * 1000) / metresPerPx(s.v.lat, z);
  const dots = c.box.flatMap((v) => {
    const [x, y] = project(s.v.lon, s.v.lat, z, v.lon, v.lat);
    return Math.hypot(x, y) <= ring * 1.3 ? [{ x, y, m: v.mmsi }] : [];
  });
  return (
    <Card
      icon="map"
      title="Map"
      right={where === "browser" ? <Btn label="Map: the custom object view" icon="arrow-right" onClick={() => c.go("cov")} className="lnk">Open</Btn> : null}
    >
      <div className="pxo-map">
        <Sat lon={s.v.lon} lat={s.v.lat} z={z} label={`Satellite plate around ${s.name}, ${R_KM} km ring`}>
          <defs>
            <radialGradient id="px-heat">
              <stop offset="0" stopColor="rgb(205,98,108)" stopOpacity=".3" />
              <stop offset="1" stopColor="rgb(205,98,108)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {dots.map((d) => <circle key={d.m} cx={d.x} cy={d.y} r={ring * 0.45} fill="url(#px-heat)" />)}
          <circle r={ring} fill="none" stroke="rgba(0,0,10,.65)" strokeWidth={4} />
          <circle r={ring} fill="none" stroke="#c5ccd4" strokeWidth={2} />
          <rect x={-8} y={-8} width={16} height={16} rx={2} fill="none" stroke="#e0a64a" strokeWidth={2.5} />
        </Sat>
      </div>
      <div className="px-mu px-card-b">{R_KM} km ring around the last fix · {dots.length} vessels in the recorder box inside it</div>
    </Card>
  );
}

export function ObjectView({ c, where }: { c: Ctx; where: "browser" | "cov" }): JSX.Element {
  const s = c.sel;
  const other = where === "browser" ? "cov" : "browser";
  const otherName = where === "browser" ? "the custom object view" : "the Browser";
  if (!s)
    return (
      <div className="px-pane pxo">
        <p className="px-empty">
          {c.boxRes && !c.boxRes.ok ? unavailable("AIS box", c.boxRes) : c.boxRes ? "No vessel matches the search" : "loading…"}
        </p>
        {where === "cov" ? <Btn label="Open the Browser" onClick={() => c.go("browser")}>Search in the Browser</Btn> : null}
      </div>
    );
  const trk = TRK(s.mmsi);
  const fx = c.fixes;
  const t0 = fx[0]?.[0] ?? s.v.t;
  const t1 = fx[fx.length - 1]?.[0] ?? s.v.t;
  const flag = c.entity?.flag_country ?? (c.entity ? "—" : "loading…");
  const media: [number, string][] = [[17, "tall"], [15, "wide"], [13, "narrow"]];
  return (
    <div className="px-pane pxo">
      <header className="pxo-head">
        <span className="px-thumb pxo-th"><Sat lon={s.v.lon} lat={s.v.lat} z={16} w={64} h={64} /></span>
        <div>
          <h2 className="pxo-name">{s.name}</h2>
          <div className="px-mu">Vessel · {trk}</div>
        </div>
        <span className="px-gap" />
        <Btn label={`Actions: ${where === "browser" ? "open the custom object view" : "the inbox feed"}`} icon="caret-down" onClick={() => c.go(where === "browser" ? "cov" : "inbox")}>Actions</Btn>
      </header>
      <div className="px-tabs">
        <Tab label="Overview" current />
        <Tab label={`Properties: ${otherName}`} onClick={() => c.go(other)} />
        <Tab label={`Links: ${otherName}`} onClick={() => c.go(other)} />
        {where === "browser" ? <Tab label="Map: the custom object view" onClick={() => c.go("cov")} /> : <Tab label="Map" why="The map card is on this tab" />}
        <Tab label={`Media: ${otherName}`} badge={N_MEDIA} onClick={() => c.go(other)} />
        <Tab label={where === "browser" ? "History: the object's inbox feed" : "History: the inbox feed"} onClick={() => c.go("inbox")} />
        <Tab label="Ava" icon="search-around" why="The assistant opens from the AI app" />
      </div>
      <div className="pxo-grid">
        <Card icon="properties" title="Properties" right={<Btn label={`View all properties: ${otherName}`} icon="arrow-right" onClick={() => c.go(other)} className="lnk">View all {nProps(s.v)}</Btn>}>
          <Kv k="Position" src="AIS">
            {s.v.lat.toFixed(5)} N, {s.v.lon.toFixed(5)} E
            <div className="px-mu">{s.d.toFixed(1)} km from {(c.place?.name ?? "").replace("Lpg", "LPG")}</div>
          </Kv>
          <Kv k="Reported name" src="AIS">{s.name}</Kv>
          <Kv k="Flag state" src="AIS">{flag}</Kv>
          <Kv k="Fix times" src="AIS">
            <div>{hhmm(t1, true)} {dmy(t1)}</div>
            <div>{hhmm(t0, true)} {dmy(t0)}</div>
          </Kv>
          <Kv k="Ship type" src="AIS">{dash(s.type)}</Kv>
          <Kv k="Speed over ground" src="AIS">{s.sog.toFixed(1)} kn</Kv>
        </Card>
        <Card icon="camera" title="Media" right={<Btn label={`View all media: ${otherName}`} icon="arrow-right" onClick={() => c.go(other)} className="lnk">View all {media.length}</Btn>}>
          <div className="pxo-media">
            {media.map(([z], i) => (
              <figure key={z}>
                <span className="pxo-shot"><Sat lon={s.v.lon} lat={s.v.lat} z={z} w={120} h={90} label={`${trk} (${i + 1})`} /></span>
                <figcaption>{trk} ({i + 1})<span className="px-mu"> · OSINT</span></figcaption>
              </figure>
            ))}
          </div>
        </Card>
        <MapCard c={c} where={where} />
        <LinksCard c={c} where={where} />
        <Card icon="document-share" title="Related Artifacts" className="pxo-art">
          <ul className="pxo-arts">
            {c.evidence.slice(0, 4).map((e) => {
              const ttl = e.props.title || e.props.source_url || e.props.filename || "capture";
              return (
                <li key={e.id}>
                  <Btn label={`${ttl}: the evidence locker`} icon="edit" onClick={() => c.go("chat")}>{ttl.length > 24 ? `${ttl.slice(0, 24)}...` : ttl}</Btn>
                </li>
              );
            })}
          </ul>
          {!c.evidence.length ? <p className="px-empty">The evidence locker is empty</p> : null}
        </Card>
      </div>
    </div>
  );
}
