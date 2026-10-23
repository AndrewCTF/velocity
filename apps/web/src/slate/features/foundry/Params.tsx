// D188/D189 the action-style parameter editor on the real workflow block
// parameter bbox (sec_d188 / sec_d189, _build_foundry_apps.py:729-779).
import {
  BLU,
  CONTENT,
  DARK,
  E,
  GREY,
  Fr,
  Hit,
  I,
  chk,
  frag,
  hairline,
  kit,
  toggle,
  vline,
  type N,
} from "./kit.js";
import { useJson, why, type Block } from "./data.js";
import type { Nav } from "./nav.js";

function useParam(): {
  blk: Block | undefined;
  p: Block["config_schema"][number] | undefined;
  err: string | null;
} {
  const r = useJson<Block[]>("/api/workflows/blocks");
  const blk = r?.data?.find((b) => b.type === "source.aircraft");
  return {
    blk,
    p: blk?.config_schema[0],
    err:
      why("Workflow blocks", r) ??
      (r?.ok && !blk ? "Block source.aircraft not found" : null),
  };
}

const capFirst = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function D188({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx, sel_box, btn } = kit(1.12);
  const W = 876;
  const H = 584;
  const { blk, p, err } = useParam();
  const o: N[] = [
    E(0, 0, W, H, `background:${CONTENT}`),
    bx(5, 6, 862, 139, "#fff", "#d3d8de", 2),
    vline(617, 7, 137),
    txt(26, 38, "Bounding box", 14, DARK, 700),
    I("trash", 582, 38, 16, "#5f6b7c"),
    txt(26, 71, p?.help ?? err ?? "", 12.5, GREY, 400, null, "l", true),
    hairline(26, 104, 571),
  ];
  (
    [
      ["Value", 26],
      ["Display", 83],
      ["Overrides", 152],
      ["Details", 237],
    ] as const
  ).forEach(([lab, xx]) =>
    o.push(txt(xx, 126, lab, 12.5, lab === "Details" ? "#215db0" : DARK)),
  );
  o.push(
    E(237, 142, 44, 2, `background:${BLU}`),
    txt(638, 36, "Type", 12.5),
    sel_box(638, 51, 209, 29, p ? capFirst(p.type) : "", 12.5, "#f6f7f9", {
      icon: I("citation", 657, 66, 14, "#404854"),
    }),
    bx(5, 164, 862, 216, "#fff", "#d3d8de", 2),
    txt(26, 190, "Details", 12.5, DARK, 700),
    hairline(6, 214, 860),
    txt(26, 244, "ID", 12, "#5c7080"),
    E(26, 260, 821, 30, "background:#e5e8ec"),
    txt(36, 275.5, p?.key ?? "", 12.5, "#8f99a8"),
    txt(26, 314, "Block", 12, "#5c7080"),
    E(26, 330, 821, 30, "background:#e5e8ec"),
    txt(36, 345.5, blk?.type ?? "", 12.5, "#8f99a8"),
    I("clipboard", 832, 345, 14, "#5f6b7c"),
    bx(5, 399, 862, 173, "#fff", "#d3d8de", 2),
    txt(26, 425, "Typeclasses", 12.5, DARK, 700),
    hairline(6, 449, 860),
    bx(26, 471, 821, 41, "#f6f7f9", "#d3d8de", 2),
    txt(47, 492.5, "placeholder", 12.5, DARK),
    txt(421, 492, ":", 12.5, BLU),
    txt(447, 492.5, p?.placeholder ?? "", 12.5, DARK),
    btn(26, 523, 156, 28, "Add new type class", "add", "#fff", "#c5cbd3", DARK),
    Hit(20, 110, 52, 30, "Value", () => nav.go("d189")),
    Hit(
      822,
      333,
      22,
      24,
      "Copy block type",
      blk ? () => void navigator.clipboard?.writeText(blk.type) : undefined,
      "Block not loaded",
    ),
    Hit(
      26,
      523,
      156,
      28,
      "Add new type class",
      undefined,
      "Typeclasses are fixed by the block schema",
    ),
    Hit(
      570,
      26,
      24,
      24,
      "Delete parameter",
      undefined,
      "Block parameters are defined by the backend block registry",
    ),
    Hit(5, 6, 200, 60, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

export function D189({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx, sel_box } = kit(1.5);
  const W = 1192;
  const H = 1126;
  const { p, err } = useParam();
  const req = !!p?.required;
  const o: N[] = [
    E(0, 0, W, H, `background:${CONTENT}`),
    bx(24, 29, 1147, 209, "#fff", "#d3d8de", 3),
    vline(796, 30, 207),
    txt(
      55,
      75,
      "Bounding box",
      12.5,
      DARK,
      700,
      null,
      "l",
      false,
      "font-size:25px",
    ),
    I("trash", 742, 75, 24, "#5f6b7c"),
    txt(55, 127, p?.help ?? err ?? "", 12.5, GREY, 400, null, "l", true),
    hairline(55, 176, 710),
  ];
  (
    [
      ["Value", 55],
      ["Display", 140],
      ["Overrides", 244],
      ["Details", 371],
    ] as const
  ).forEach(([lab, xx]) =>
    o.push(txt(xx, 207, lab, 12.5, lab === "Value" ? "#215db0" : DARK)),
  );
  o.push(
    E(55, 233, 56, 3, `background:${BLU}`),
    txt(827, 67, "Type", 12.5),
    sel_box(827, 88, 313, 44, p ? capFirst(p.type) : "", 12.5, "#f6f7f9", {
      icon: I("citation", 856, 110, 22, "#404854"),
      idx: 40,
      cs: 1.6,
    }),
  );
  const tile = (
    x0: number,
    x1: number,
    label: string,
    add: boolean,
    state: boolean,
    dis = false,
  ): N =>
    frag([
      bx(x0, 371, x1 - x0, 94, "#fff", "#c5cbd3", 3),
      add
        ? frag([
            txt(x0 + 16, 401, label, 12.5),
            E(x0 + 16, 419, 138, 31, "background:#eceff2;border-radius:3px"),
            I("refresh", x0 + 34, 434, 22, "#404854"),
            txt(x0 + 49, 434.5, "Add override", 12.5),
          ])
        : txt(x0 + 16, 418, label, 12.5, DARK),
      toggle(x1 - 72, add ? 406 : 405, state, 41, 25, dis),
    ]);
  o.push(
    bx(24, 266, 1147, 229, "#fff", "#d3d8de", 3),
    txt(
      55,
      304,
      "General",
      12.5,
      DARK,
      700,
      null,
      "l",
      false,
      "font-size:20px",
    ),
    hairline(25, 341, 1145),
    tile(54, 398, "Visible", true, true),
    tile(426, 769, "Disabled", false, false, true),
    // Required = the block schema's required flag
    tile(797, 1141, "Required", true, req),
    bx(24, 523, 1147, 441, "#fff", "#d3d8de", 3),
    txt(
      55,
      561,
      "Constraints",
      12.5,
      DARK,
      700,
      null,
      "l",
      false,
      "font-size:20px",
    ),
    hairline(25, 599, 1145),
    txt(55, 644, "Allow multiple values", 12.5),
    txt(
      55,
      671,
      `Users will be able to select more than one ${p?.type ?? ""}`,
      12.5,
      GREY,
    ),
    toggle(1099, 638, false, 41, 25),
  );
  (
    [
      [55, 326, "User input", "annotation", true],
      [341, 655, "Multiple choice", "properties", false],
      [670, 889, "User", "user", false],
      [905, 1140, "Group", "people", false],
    ] as const
  ).forEach(([x0, x1, lab, ic, on]) =>
    o.push(
      bx(
        x0,
        714,
        x1 - x0,
        78,
        on ? "#f2f8fe" : "#f6f6f8",
        on ? BLU : "#e1e5ea",
        2,
      ),
      I(ic, x0 + 38, 753, 28, on ? BLU : "#404854"),
      txt(x0 + 77, 753.5, lab, 12.5, on ? "#215db0" : GREY),
    ),
  );
  o.push(I("tick", 291, 753, 24, BLU));
  (
    [
      [836, "With minimum length"],
      [878, "With maximum length"],
      [920, "Matching regex"],
    ] as const
  ).forEach(([y, lab]) =>
    o.push(chk(55, y - 12, false, 24), txt(95, y, lab, 12.5)),
  );
  o.push(
    bx(24, 992, 1147, 108, "#fff", "#d3d8de", 3),
    txt(
      55,
      1029,
      "Default value",
      12.5,
      DARK,
      700,
      null,
      "l",
      false,
      "font-size:20px",
    ),
    txt(
      55,
      1064,
      "Set a default value for the input. It can be overriden by users.",
      12.5,
      GREY,
    ),
    toggle(1099, 1026, false, 41, 25),
    Hit(355, 190, 90, 34, "Details", () => nav.go("d188")),
    Hit(24, 29, 300, 80, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
