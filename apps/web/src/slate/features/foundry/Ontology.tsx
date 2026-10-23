// Ontology Manager frames D184-D187 and the property editor D190
// (om_old, base_row, field_label, prop_sel, sec_d184-d187, sec_d190;
// _build_foundry_apps.py:557-803), line for line, on the live schema.
import { BLU, CONTENT, DARK, E, FAINT, GREY, Fr, Hit, I, chk, frag, hairline, kit, span, toggle, tri, vline, type Kit, type N } from "./kit.js";
import { nf, useJson, why, type Binding, type Dataset, type Schema, type Status } from "./data.js";
import type { Nav } from "./nav.js";

const KIND_TILE: Record<string, string> = { aircraft: "#12a89d", vessel: "#2d72d2", situation: "#d9822b", resource: "#8f56bf", incident: "#cd4246", evidence: "#5f6b7c" };
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const LEARN = span("Learn more.", "color:#215db0");

function omOld(
  k: Kit,
  W: number,
  H: number,
  name: string,
  sub: string,
  tileBg: string,
  glyph: string,
  navN: number | string,
  cards: N,
  nav: Nav,
  o2: { save?: boolean; star?: boolean; dots?: boolean } = {},
): N {
  const { txt, bx, btn, tile_icon } = k;
  const save = !!o2.save;
  const o: N[] = [
    E(0, 0, W, H, `background:${CONTENT}`),
    E(0, 0, 349, H, "background:#fff"),
    vline(349, 50, H - 50),
    E(0, 0, W, 50, "background:#fff"),
    hairline(0, 50, W),
    E(0, 0, 49, 50, "background:#e8f0fc"),
    I("cube", 24, 24, 24, "#2d72d2"),
    vline(49, 0, 50),
    txt(70, 25, "Ontology", 13, BLU),
    tri(132, 22, `border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid ${BLU}`),
    vline(167, 14, 22),
    txt(188, 25, "Archetypes", 13, BLU),
    E(268, 10, 74, 30, "background:#c6d7f1;border-radius:2px"),
    txt(278, 25.5, "Ontology", 13, "#215db0"),
    bx(save ? 557 : 634, 10, 239, 30, "#f6f7f9", "#c5cbd3", 2),
    I("search", save ? 575 : 652, 25, 16, "#404854"),
    txt(save ? 588 : 665, 25.5, "Search…", 13, GREY),
    txt((save ? 796 : 873) - 12, 25.5, "Ctrl + K", 11, FAINT, 400, 60, "r"),
    I("arrow-left", 23, 75, 16, "#404854"),
    txt(41, 75.5, "Back home", 12.5),
    hairline(0, 99, 349),
    tile_icon(10, 110, 42, tileBg, glyph, "#fff"),
    txt(62, 123, name, 15, DARK),
    txt(62, 142, sub, 11, GREY),
  ];
  if (o2.star !== false) o.push(I("star-empty", 171, 141, 15, "#a5acb6"));
  if (o2.dots) o.push(I("more", 318, 130, 16, "#404854"));
  o.push(hairline(0, 163, 349));
  (
    [
      ["desktop", "Overview", ""],
      ["properties", "Properties", ` (${navN})`],
      ["shield", "Security", ""],
      ["database", "Datasources", ""],
      ["layers", "Capabilities", ""],
    ] as const
  ).forEach(([ic, lab, cnt], i) => {
    const yy = 191 + 40 * i;
    if (lab === "Capabilities") o.push(bx(10, yy - 18, 329, 36, "#f8fcfe", BLU, 2));
    o.push(I(ic, 27, yy, 16, "#404854"), txt(46, yy + 0.5, lab, 13, lab === "Capabilities" ? BLU : DARK));
    if (cnt) o.push(txt(46 + lab.length * 6.7, yy + 0.5, cnt, 13, GREY));
  });
  if (save)
    o.push(
      vline(1084, 0, 50),
      btn(1094, 10, 66, 29, "Discard", null, "#f6f7f9", "#c5cbd3"),
      btn(1169, 10, 48, 29, "Save", null, "#238551", "#238551", "#fff", 12.5, 400),
      Hit(1094, 10, 123, 29, "Discard or save", undefined, "Nothing edited: capabilities are read from the live schema"),
    );
  o.push(
    cards,
    Hit(0, 0, 49, 50, "Foundry apps", nav.menu),
    Hit(10, 62, 150, 26, "Back home", () => nav.workbench("home")),
    Hit(10, 173, 329, 36, "Overview", () => nav.workbench("ontology")),
    Hit(10, 293, 329, 36, "Datasources", () => nav.workbench("datasets")),
  );
  return frag(o);
}

function baseRow(k: Kit, x: number, y: number, w: number, h: number, name: string, desc: string, on = false): N {
  const { txt, bx } = k;
  return frag([
    bx(x, y, w, h, "#fff", "#d3d8de", 2),
    chk(x + 21, y + h / 2 - 8, on),
    txt(x + 47, y + h / 2, name, 12.5, DARK, 700),
    txt(x + 47 + name.length * 6.4 + 7, y + h / 2, ["– " + desc + " ", LEARN], 12.5, FAINT),
  ]);
}

function fieldLabel(k: Kit, x: number, y: number, title: string, desc: string, learn = false): N {
  return frag([
    k.txt(x, y, title, 12.5, DARK),
    k.txt(x, y + 18, learn ? [desc + " ", span("Learn more", "color:#215db0;border-bottom:1px dashed #8f99a8")] : desc, 12.5, FAINT),
  ]);
}

function propSel(k: Kit, x: number, y: number, w: number, label = "Choose a property", o: { icon?: N; clear?: boolean; tag?: string; h?: number; solid?: boolean } = {}): N {
  const h = o.h ?? 30;
  const solid = !!o.solid;
  const cx = x + w - 15;
  return frag([
    k.bx(x, y, w, h, solid ? BLU : "#f6f7f9", solid ? BLU : "#c5cbd3", 2, solid ? "" : "box-shadow:inset 0 -1px 0 rgba(17,20,24,.08)"),
    o.icon ?? null,
    k.txt(x + 9 + (o.icon ? 22 : 0), y + h / 2 + 0.5, label, 12.5, solid ? "#fff" : DARK),
    tri(cx - 5, y + h / 2 - 2, `border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid ${solid ? "#fff" : "#5f6b7c"}`),
    o.clear ? I("small-cross", cx - 20, y + h / 2, 12, "#5f6b7c") : null,
    o.tag ? frag([E(cx - 90, y + h / 2 - 9, 42, 18, "background:#e5e8ec;border-radius:2px"), k.txt(cx - 69, y + h / 2 + 0.5, o.tag, 10.5, GREY, 400, 42, "c")]) : null,
  ]);
}

const numicon = (k: Kit, x: number, y: number, s = "1.0"): N => frag([k.bx(x, y - 8, 17, 16, "#fff", "#c5cbd3", 2), k.txt(x + 8.5, y + 0.5, s, 7, GREY, 400, 17, "c")]);

function baseTypesCard(k: Kit, x: number, y: number, w: number, rows: N, bottom: number): N {
  return frag([
    k.bx(x, y, w, bottom - y, "#fff", "#d3d8de", 3),
    I("hat", x + 29, y + 26, 16, "#5f6b7c"),
    k.txt(x + 47, y + 26, "Base Types", 12.5, DARK, 700),
    I("chevron-down", x + w - 24, y + 26, 14, "#5f6b7c"),
    hairline(x + 1, y + 51, w - 2),
    rows,
  ]);
}

const errLine = (k: Kit, ...msgs: Array<string | null>): N => {
  const m = msgs.filter(Boolean).join(" · ");
  return m ? k.txt(400, 40, m, 11, "#ac2f33") : null;
};

export function D184({ nav }: { nav: Nav }): JSX.Element {
  const k = kit(1.08);
  const { txt, bx } = k;
  const W = 1225;
  const H = 766;
  const sc = useJson<Schema>("/api/ontology/schema");
  const si = useJson<unknown[]>("/api/situations");
  const props = Object.keys(sc?.data?.kinds.situation ?? {});
  const n = si?.data?.length;
  const rows = frag([
    baseRow(k, 412, 140, 754, 59, "Time Series", "each Object represents a series of values over time."),
    baseRow(k, 412, 205, 754, 59, "Event", "each Object represents a single interval of time, optionally with associated information."),
    baseRow(k, 412, 270, 754, 59, "Vertex", "each Object represents a node or edge in the Vertex Graph view."),
  ]);
  const geo = frag([
    bx(412, 335, 754, 389, "#fff", "#d3d8de", 2),
    chk(433, 357, true),
    txt(459, 365.5, "Geospatial", 12.5, DARK, 700),
    txt(459 + 74, 365.5, ["– each Object represents a geospatial feature. ", LEARN], 12.5, FAINT),
    fieldLabel(k, 433, 403, "Altitude", "Numeric property specifying altitude/elevation of each Object in metres"),
    propSel(k, 433, 440, 300),
    hairline(433, 485, 712),
    fieldLabel(k, 433, 510, "Radius", "Numeric property specifying the radius in kilometres, to render object as circles - must also have a 'Geo' property"),
    txt(433, 546, "indicating the center of the circle", 12.5, FAINT),
    // Radius is bound to the schema's radius_km (kilometres, hence the helper text)
    propSel(k, 433, 566, 300, props.includes("radius_km") ? "Radius Km" : "Choose a property", props.includes("radius_km") ? { icon: numicon(k, 442, 581), clear: true, tag: "Active" } : {}),
    hairline(433, 610, 712),
    fieldLabel(k, 433, 635, "H3 cell", "String property, or array of strings, containing H3 cell IDs.", true),
    propSel(k, 433, 673, 300),
  ]);
  const cards = frag([baseTypesCard(k, 391, 69, 796, frag([rows, geo]), 749), errLine(k, why("Ontology schema", sc), why("Situations", si))]);
  return (
    <Fr W={W} H={H}>
      {omOld(k, W, H, "Situation", n === undefined ? "" : `${n} objects`, KIND_TILE.situation!, "warning-sign", props.length, cards, nav, { star: false })}
    </Fr>
  );
}

export function D185({ nav }: { nav: Nav }): JSX.Element {
  const k = kit(1.08);
  const { txt, bx, inp } = k;
  const W = 1226;
  const H = 1113;
  const sc = useJson<Schema>("/api/ontology/schema");
  const st = useJson<Status>("/api/status");
  const props = Object.keys(sc?.data?.kinds.aircraft ?? {});
  const nAc = st?.data?.aircraft_count;
  const rel = sc?.data?.relations.designated_by;
  const rows = baseRow(k, 412, 139, 736, 59, "Time Series", "each Object represents a series of values over time.");
  const clock = I("time", 451, 324, 14, "#404854");
  const quote = I("citation", 451, 754, 14, "#404854");
  // the linked object is the schema relation designated_by (aircraft to org)
  const link = rel
    ? frag([
        E(442, 531, 18, 18, `background:${KIND_TILE.aircraft};border-radius:2px`),
        I("airplane", 451, 540, 12, "#fff"),
        txt(463, 540, "Aircraft", 12.5),
        I("link", 518, 540, 13, "#5f6b7c"),
        E(536, 531, 18, 18, "background:#8f56bf;border-radius:2px"),
        I("office", 545, 540, 12, "#fff"),
        txt(558, 540, cap(rel.dst_kinds[0] ?? ""), 12.5),
      ])
    : null;
  const has = (p: string): boolean => props.includes(p);
  const ev = frag([
    bx(412, 205, 736, 905, "#fff", "#d3d8de", 2),
    chk(433, 227, true),
    txt(459, 235, "Event", 12.5, DARK, 700),
    txt(459 + 42, 235, ["– each Object represents a single interval of time, optionally with associated information. ", LEARN], 12.5, FAINT),
    fieldLabel(k, 432, 273, "Event start time", "Time at which the event begins"),
    propSel(k, 432, 309, 300, has("seen_at") ? "Seen At" : "Choose a property", has("seen_at") ? { icon: clock, clear: true } : {}),
    hairline(432, 354, 695),
    fieldLabel(k, 432, 380, "Event end time", "Time at which the event ends"),
    propSel(k, 432, 416, 300),
    hairline(432, 461, 695),
    fieldLabel(k, 432, 487, "Linked object", "Associates events with another object type.", true),
    propSel(k, 432, 524, 300, ""),
    link,
    hairline(432, 569, 695),
    fieldLabel(k, 432, 595, "Linked series ID", "Associates events with Time Series.", true),
    propSel(k, 432, 632, 300),
    hairline(432, 677, 695),
    fieldLabel(k, 432, 703, "Description", "Textual description of the event"),
    propSel(k, 432, 739, 300, has("callsign") ? "Callsign" : "Choose a property", has("callsign") ? { icon: quote, clear: true } : {}),
    hairline(432, 784, 695),
    fieldLabel(k, 432, 810, "Event intent", "Severity of the event"),
    propSel(k, 432, 846, 270, "primary", { solid: true }),
    I("small-cross", 717, 861, 14, "#c23030"),
    hairline(432, 891, 695),
    fieldLabel(k, 432, 917, "Event value", "Numeric value of the event"),
    propSel(k, 432, 953, 300),
    hairline(432, 998, 695),
    fieldLabel(k, 432, 1024, "Event value unit", "Unit of measurement for numeric value of the event"),
    inp(432, 1061, 300, 29, "Type a value...", 12.5, DARK, "#fff", "#abb3bf", true),
  ]);
  const cards = frag([
    bx(391, 68, 778, 1100, "#fff", "#d3d8de", 3),
    I("hat", 419, 94, 16, "#5f6b7c"),
    txt(437, 94.5, "Base Types", 12.5, DARK, 700),
    I("chevron-down", 1145, 94, 14, "#5f6b7c"),
    hairline(392, 118, 776),
    rows,
    ev,
    E(1212, 66, 12, 640, "background:#c5cbd3;border-radius:6px"),
    errLine(k, why("Ontology schema", sc), why("Status", st)),
  ]);
  return (
    <Fr W={W} H={H}>
      {omOld(k, W, H, "Aircraft", nAc === undefined ? "" : `${nf(nAc)} objects`, KIND_TILE.aircraft!, "airplane", props.length, cards, nav, { save: true, star: true, dots: true })}
    </Fr>
  );
}

export function D186({ nav }: { nav: Nav }): JSX.Element {
  const k = kit(1.08);
  const { txt, bx } = k;
  const W = 1226;
  const H = 711;
  const sc = useJson<Schema>("/api/ontology/schema");
  const dsR = useJson<Dataset[]>("/api/foundry/datasets");
  const ds = dsR?.data?.find((d) => d.name === "ref_country_osint_resources");
  const sch = ds?.schema.map((c) => c.name) ?? [];
  const rels = Object.entries(sc?.data?.relations ?? {});
  const inc = rels.find(([, v]) => v.dst_kinds.includes("resource"));
  const out = rels.find(([, v]) => v.src_kinds.includes("resource"));
  const rows = frag([
    baseRow(k, 412, 138, 754, 60, "Time Series", "each Object represents a series of values over time."),
    baseRow(k, 412, 203, 754, 60, "Event", "each Object represents a single interval of time, optionally with associated information."),
  ]);
  const geo = frag([
    bx(412, 268, 754, 60, "#fff", "#d3d8de", 2),
    txt(432, 298.5, "Geospatial", 12.5, DARK, 700),
    txt(432 + 66, 298.5, ["– each Object represents a geospatial feature. ", LEARN], 12.5, FAINT),
    I("chevron-up", 1136, 298, 14, "#404854"),
  ]);
  const merge = (y: number, title: string, desc: string, rel: (typeof rels)[number] | undefined): N =>
    frag([
      fieldLabel(k, 432, y, title, desc, true),
      bx(432, y + 38, 300, 31, "#fff", BLU, 2),
      I("add", 530, y + 53, 14, BLU),
      txt(551, y + 53.5, "Add new entry", 12.5, BLU),
      rel
        ? frag([
            bx(745, y + 37, 270, 28, "#f6f7f9", "#c5cbd3", 3),
            txt(755, y + 51.5, `${cap(rel[1].src_kinds[0] ?? "")} → ${cap(rel[1].dst_kinds[0] ?? "")}`, 12, DARK),
            txt(870, y + 51.5, rel[0], 11, GREY),
            E(960, y + 42, 46, 18, "background:#d4e0f4;border-radius:2px"),
            txt(983, y + 51.5, "Active", 10.5, "#215db0", 400, 46, "c"),
          ])
        : null,
    ]);
  const sa = frag([
    bx(412, 334, 754, 376, "#fff", "#d3d8de", 2),
    txt(432, 363, "Search Around", 12.5, DARK, 700),
    txt(432 + 88, 363, "– configure specific Search Around behavior for the Vertex and Map applications", 12.5, FAINT),
    fieldLabel(k, 432, 401, "Link merge always", "Treat this Object Type as a Relation: skip over it when link-traversing"),
    bx(432, 437, 300, 31, "#f6f7f9", "#c5cbd3", 2),
    vline(582, 438, 29, "#c5cbd3"),
    E(583, 438, 148, 29, "background:#dce0e5"),
    txt(507, 453.5, "Off", 12.5, DARK, 400, 150, "c"),
    txt(657, 453.5, "On", 12.5, DARK, 400, 150, "c"),
    hairline(432, 487, 712),
    merge(512, "Incoming links to merge", "Relations ending at this Object Type, to be skipped over when link-traversing.", inc),
    hairline(432, 595, 712),
    merge(620, "Outgoing links to merge", "Relations starting at this Object Type, to be skipped over when link-traversing.", out),
  ]);
  const cards = frag([
    bx(391, 67, 776, 644, "#fff", "#d3d8de", 3),
    I("hat", 419, 93, 16, "#5f6b7c"),
    txt(437, 93.5, "Base Types", 12.5, DARK, 700),
    I("chevron-down", 1162, 93, 14, "#5f6b7c"),
    hairline(392, 117, 774),
    rows,
    geo,
    sa,
    errLine(k, why("Ontology schema", sc), why("Foundry datasets", dsR), dsR?.ok && !ds ? "Dataset ref_country_osint_resources not found" : null),
  ]);
  return (
    <Fr W={W} H={H}>
      {omOld(k, W, H, "Resource", ds ? `${nf(ds.row_count)} rows` : "", KIND_TILE.resource!, "link", sch.length, cards, nav, { star: false, dots: true })}
    </Fr>
  );
}

export function D187({ nav }: { nav: Nav }): JSX.Element {
  const k = kit(1);
  const { txt, bx, btn, sel_box } = k;
  const W = 1335;
  const H = 736;
  const sc = useJson<Schema>("/api/ontology/schema");
  const st = useJson<Status>("/api/status");
  const bR = useJson<Binding[]>("/api/foundry/bindings");
  const dR = useJson<Dataset[]>("/api/foundry/datasets");
  const props = Object.keys(sc?.data?.kinds.vessel ?? {});
  const bnd = bR?.data?.[0];
  const dsn = bnd ? dR?.data?.find((d) => d.id === bnd.dataset_id) : undefined;
  const nVes = st?.data?.vessel_count;
  const o: N[] = [
    E(0, 0, W, H, `background:${CONTENT}`),
    E(0, 0, 232, H, "background:#fff"),
    vline(232, 0, H),
    E(0, 0, W, 38, "background:#fff"),
    hairline(0, 38, W),
    I("cube", 17, 18, 18, "#2d72d2"),
    txt(48, 18.5, "Ontology Manager", 12, DARK, 700),
    bx(530, 7, 275, 24, "#f6f7f9", "#c5cbd3", 2),
    I("search", 545, 19, 14, "#404854"),
    txt(561, 19.5, "Search resources…", 11, GREY),
    txt(795, 19.5, "⌘K", 10, FAINT, 400, 40, "r"),
    I("git-branch", 1200, 18, 13, "#404854"),
    txt(1213, 18.5, "Main", 11, DARK),
    I("caret-down", 1247, 18, 11, "#5f6b7c"),
    btn(1272, 7, 54, 23, "New", null, "#fff", "#c5cbd3", DARK, 11),
    I("caret-down", 1315, 18, 10, "#5f6b7c"),
    E(233, 39, W - 233, 31, "background:#e6e8ec"),
    I("info-sign", 244, 55, 12, "#5f6b7c"),
    txt(
      257,
      55.5,
      bnd && dsn
        ? ["This object type is bound to the Foundry dataset ", span(dsn.name, "color:#215db0"), ` by binding ${bnd.id}.`]
        : (why("Foundry bindings", bR) ?? (bR?.ok ? "This object type has no Foundry binding." : "")),
      11,
      DARK,
    ),
    bx(1161, 44, 166, 23, "#f6f7f9", "#c5cbd3", 2),
    txt(1171, 55.5, "Open", 11, DARK),
    I("th", 1204, 55, 11, GREY),
    E(1218, 49, 100, 13, "background:#d3d8de;border-radius:2px;opacity:.6"),
    I("arrow-left", 15, 53, 13, "#404854"),
    txt(29, 53.5, "Home", 11),
    hairline(0, 68, 232),
    E(6, 79, 30, 30, "background:#ecf2fc;border-radius:3px"),
    I("ship", 21, 94, 17, "#2d72d2"),
    txt(45, 87, "Vessel", 12, DARK),
    txt(45, 102, nVes === undefined ? "" : `${nf(nVes)} objects`, 9.5, GREY),
    hairline(0, 123, 232),
  ];
  const navRows: Array<[string, string, string]> = [
    ["desktop", "Overview", ""],
    ["properties", "Properties", props.length ? String(props.length) : ""],
    ["shield", "Security", "New"],
    ["database", "Datasources", ""],
    ["timeline-line-chart", "Observability", ""],
    ["layers", "Capabilities", ""],
    ["widget", "Object views", ""],
    ["edit", "Application styles", ""],
    ["form", "Interfaces", ""],
    ["upload", "Materializations", ""],
    ["flash", "Automations", ""],
    ["series-derived", "Usage", ""],
    ["history", "History", ""],
  ];
  navRows.forEach(([ic, lab, bad], i) => {
    const yy = 140 + 31.4 * i;
    if (lab === "Capabilities") o.push(bx(5, yy - 13, 218, 26, "#f2f8fe", BLU, 2));
    o.push(I(ic, 18, yy, 13, "#404854"), txt(33, yy + 0.5, lab, 10.5, lab === "Capabilities" ? BLU : DARK));
    if (bad === "New") o.push(E(196, yy - 6, 23, 12, "background:#7ee0c2;border-radius:6px"), txt(207.5, yy + 0.5, "New", 7, "#0a4d3a", 700, 23, "c"));
    else if (bad) o.push(E(88, yy - 7, 19, 14, "background:#e5e8ec;border-radius:2px"), txt(97.5, yy + 0.5, bad, 8.5, GREY, 400, 19, "c"));
  });
  const capCard = (y0: number, y1: number, title: string, desc: string, ic: string): N =>
    frag([
      bx(371, y0, 816, y1 - y0, "#fff", "#d3d8de", 3),
      I(ic, 392, y0 + 18, 13, "#5f6b7c"),
      txt(406, y0 + 12, title, 10.5, DARK, 700),
      txt(406, y0 + 26, desc, 10.5, GREY),
      txt(1088, y0 + 18, "Learn more", 10, "#215db0"),
      I("chevron-right", 1168, y0 + 18, 12, "#5f6b7c"),
    ]);
  o.push(
    bx(371, 60, 816, 43, "#fff", "#d3d8de", 3),
    I("globe", 392, 77, 13, "#5f6b7c"),
    txt(406, 85, "Each Object represents a geospatial feature.", 10.5, GREY),
    txt(1088, 77, "Learn more", 10, "#215db0"),
    I("chevron-right", 1168, 77, 12, "#5f6b7c"),
    capCard(118, 159, "Search Around", "Configure specific Search Around behavior for the Vertex and Map applications", "search-around"),
    bx(371, 177, 816, 365, "#fff", "#d3d8de", 3),
    I("graph", 392, 195, 13, "#5f6b7c"),
    txt(406, 189, "Vertex", 10.5, DARK, 700),
    txt(406, 203, "Each Object is the title object for a Vertex graph", 10.5, GREY),
    txt(1088, 195, "Learn more", 10, "#215db0"),
    I("chevron-down", 1168, 195, 12, "#5f6b7c"),
    hairline(372, 218, 814),
  );
  const rowsd: Array<[number, number, string, N]> = [
    [249, 264, "Default Object Selection Panel", "Sets the default panel to show in the object selection view"],
    [302, 316, "Key Measure", ["Measures listed here will display on the Vertex home page. ", span("Learn more", "color:#215db0")]],
    [355, 369, "Vertex Promoted Graphs", "Graph RIDs listed here will display on the Vertex home page along with the associated object"],
    [409, 423, "Image reference property", "If specified: This media reference is used by default for media layers as the image shown on the node"],
    [461, 475, "Image annotation coordinate property", "If specified: This property is used by default to determine the image annotation placement relative to the parent image"],
  ];
  for (const [y1, y2, t, d] of rowsd) {
    o.push(txt(394, y1, t, 10, DARK), txt(394, y2, d, 10, GREY));
    if (y1 === 409 || y1 === 461) o.push(sel_box(947, y1 - 7, 219, 22, "Choose a property", 10.5, "#f6f7f9"));
  }
  o.push(
    sel_box(947, 243, 153, 23, "Choose a value", 10.5, "#f6f7f9"),
    E(1100, 243, 66, 23, "background:#e8eaee"),
    I("small-cross", 1133, 254, 11, "#5f6b7c"),
    bx(1100, 296, 66, 25, "#fff", BLU, 2),
    sel_box(947, 349, 219, 22, "Choose a property", 10.5, "#f6f7f9"),
    hairline(372, 494, 814),
    txt(394, 518, ["Modeling and simulation ", span("– configure series behavior in the Vertex modeling and simulation platform", "color:#8f99a8;font-weight:400")], 10.5, DARK, 700),
    I("chevron-right", 1168, 518, 12, "#5f6b7c"),
    bx(371, 555, 816, 106, "#fff", "#d3d8de", 3),
    I("feed", 392, 575, 13, "#5f6b7c"),
    txt(406, 575.5, "Offline App Sync", 10.5, DARK, 700),
    I("chevron-down", 1168, 575, 12, "#5f6b7c"),
    bx(385, 604, 786, 46, "#fff", "#d3d8de", 2),
    txt(402, 621, "Enable offline app sync for this object type", 10, DARK, 700),
    txt(402, 635, "This setting enables offline syncing of this object type for embedded ontology apps", 10, GREY),
    toggle(1126, 621 - 6, false, 22, 12),
    bx(371, 681, 816, 70, "#fff", "#d3d8de", 3),
    I("calendar", 392, 692, 13, "#5f6b7c"),
    txt(406, 692, "Dynamic Scheduling", 10.5, DARK, 700),
    txt(406, 706, "Create a dynamic scheduling workflow with your ontology object types.", 10.5, GREY),
    txt(1088, 699, "Learn more", 10, "#215db0"),
    I("chevron-down", 1168, 699, 12, "#5f6b7c"),
  );
  // dropdown with the real object inspector tabs (apps/web/src/entity-panel/ObjectInspector.tsx TABS)
  o.push(bx(947, 266, 141, 106, "#fff", "#d3d8de", 3, "box-shadow:0 2px 8px rgba(17,20,24,.25)"), E(951, 270, 133, 22, "background:#eaf0fa;border-radius:2px"));
  ["Overview", "Properties", "History", "Dossier"].forEach((lab, i) => o.push(txt(956, 281 + i * 23.3, lab, 10.5, i === 0 ? "#215db0" : DARK)));
  const e = [why("Ontology schema", sc), why("Status", st), why("Foundry datasets", dR)].filter(Boolean).join(" · ");
  if (e) o.push(txt(380, 725, e, 10, "#ac2f33"));
  o.push(
    Hit(0, 0, 232, 38, "Foundry apps", nav.menu),
    Hit(5, 42, 100, 22, "Home", () => nav.workbench("home")),
    Hit(5, 140 + 31.4 - 13, 218, 26, "Properties", () => nav.go("d190")),
    Hit(5, 140 + 31.4 * 3 - 13, 218, 26, "Datasources", () => nav.workbench("datasets")),
    Hit(1161, 44, 166, 23, "Open the bound dataset", dsn ? () => nav.workbench("datasets") : undefined, "No bound dataset"),
    Hit(1272, 7, 54, 23, "New", undefined, "Object types come from the ontology schema; they are not created here"),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

export function D190({ nav }: { nav: Nav }): JSX.Element {
  const k = kit(2.0);
  const { txt, bx, inp, sel_box } = k;
  const W = 810;
  const H = 1546;
  const sc = useJson<Schema>("/api/ontology/schema");
  const props = sc?.data?.kinds.vessel ?? {};
  const ptype = props.mmsi;
  const BT: Record<string, string> = { id: "Identifier", str: "String", num: "Number", ts: "Timestamp", bool: "Boolean", geo: "Geopoint" };
  const chipQ = span("”", "margin:0 6px;border:1px solid #c5cbd3;border-radius:3px;padding:0 5px;background:#fff");
  const o: N[] = [
    E(0, 0, W, H, "background:#fff"),
    E(8, 0, 2, H, "background:#e1e5ea"),
    I("menu-open", 60, 68, 36, "#5f6b7c"),
    bx(120, 50, 40, 38, "#f6f7f9", "#c5cbd3", 3),
    I("citation", 140, 69, 22, "#404854"),
    txt(170, 69, "mmsi", 12.5, DARK),
    I("trash", 760, 69, 34, "#cd4246"),
  ];
  (
    [
      ["General", 30],
      ["Source", 161],
      ["Display", 282],
      ["Interaction", 407],
      ["Details", 576],
    ] as const
  ).forEach(([lab, xx]) => o.push(txt(xx, 171, lab, 12.5, lab === "General" ? "#215db0" : DARK)));
  o.push(
    E(30, 197, 91, 4, `background:${BLU}`),
    hairline(10, 201, 770),
    E(789, 205, 13, 1065, "background:#c5cbd3;border-radius:7px"),
    txt(34, 239, "Overview", 12.5, DARK, 700, null, "l", false, "font-size:23px"),
    txt(34, 303, "Name", 12.5),
    inp(34, 337, 721, 58, ptype ? "mmsi" : "", 12.5),
    I("small-cross", 725, 366, 24, "#5f6b7c"),
    txt(34, 443, "Description", 12.5),
    bx(34, 476, 721, 110, "#fff", "#abb3bf", 3),
    txt(34, 636, "Base type", 12.5),
    // the schema's own type token for mmsi ('id', the identifier type)
    sel_box(34, 667, 721, 59, ptype ? `${BT[ptype] ?? ptype} (${ptype})` : (why("Ontology schema", sc) ?? ""), 12.5, "#f6f7f9", {
      icon: frag([bx(55, 679, 38, 34, "#fff", "#c5cbd3", 3), I("citation", 74, 696, 20, "#404854")]),
      idx: 75,
      cs: 2,
    }),
    E(34, 748, 721, 55, "background:#f6f6f8"),
    txt(44, 776, "Allow multiple", 12.5, GREY),
    I("help", 237, 775, 26, "#a5acb6"),
    toggle(672, 761, false, 54, 30),
    txt(34, 852, "Value type", 12.5),
    I("help", 180, 853, 26, "#a5acb6"),
    I("share", 732, 850, 26, "#5f6b7c"),
    sel_box(34, 884, 721, 65, "No value type set", 12.5, "#f6f7f9", { ph: true, icon: I("citation", 65, 917, 20, "#404854"), idx: 45, cs: 2 }),
    txt(34, 1000, "Status", 12.5),
    txt(34, 1051, "Not exposed", 12.5, "#8f99a8", 400, null, "l", false, "font-style:italic"),
    hairline(10, 1096, 770),
    txt(34, 1136, "Configuration", 12.5, DARK, 700, null, "l", false, "font-size:23px"),
    E(34, 1182, 721, 56, "background:#f6f6f8"),
    txt(44, 1211, "Title key", 12.5),
    toggle(672, 1198, false, 54, 30),
    txt(34, 1268, ["Current: ", chipQ, " name"], 12.5, GREY),
    E(34, 1312, 721, 56, "background:#f6f6f8"),
    txt(44, 1340, "Primary key", 12.5),
    // mmsi is the identity key of the vessel kind (schema type 'id')
    toggle(672, 1328, ptype === "id", 54, 30),
    txt(34, 1398, ["Current: ", chipQ, " mmsi"], 12.5, GREY),
    E(34, 1442, 721, 56, "background:#f6f6f8"),
    txt(44, 1470, "Required", 12.5),
    I("help", 168, 1470, 26, "#a5acb6"),
    toggle(672, 1457, false, 54, 30),
    hairline(10, 1540, 770),
    Hit(36, 44, 50, 50, "Back to the Vessel object type", () => nav.go("d187")),
    Hit(735, 44, 50, 50, "Delete property", undefined, "Properties come from the ontology schema; they are not deleted here"),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
