// D188/D189 the parameter editor on the real workflow block parameter bbox of
// source.aircraft, native: one page with Value and Details tabs.
import { useJson, why, type Block } from "./data.js";
import {
  Bar,
  Btn,
  Card,
  Field,
  Page,
  Pick,
  Switch,
  WHY_SCHEMA,
  dash,
} from "./native.js";
import { Ii } from "./kit.js";
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

function ParamPage({
  nav,
  tab,
}: {
  nav: Nav;
  tab: "Value" | "Details";
}): JSX.Element {
  const { blk, p, err } = useParam();
  const req = !!p?.required;
  const type = p ? capFirst(p.type) : "—";
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workflow block · {dash(blk?.type)} · <b>{dash(p?.label)}</b>
          </>
        }
      />
      <div className="fxn-body">
        <div className="fxn-scroll">
          <div className="fxn-col" style={{ maxWidth: 960 }}>
            <Card>
              <div className="fxn-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 className="fxn-h1">{dash(p?.label)}</h1>
                  <p className="fxn-p" style={{ fontStyle: "italic" }}>
                    {p?.help ?? err ?? "—"}
                  </p>
                </div>
                <Btn icon="trash" why={WHY_SCHEMA}>
                  Delete
                </Btn>
              </div>
              <div className="fxn-pair" style={{ alignItems: "end" }}>
                <Pick label="Type" value={type} why={WHY_SCHEMA} />
              </div>
              <nav
                className="fxn-tabs"
                style={{ padding: 0 }}
                aria-label="Parameter sections"
              >
                <button
                  type="button"
                  aria-current={tab === "Value" ? "page" : undefined}
                  onClick={() => nav.go("d189")}
                >
                  Value
                </button>
                <button
                  type="button"
                  disabled
                  title="Display options are not part of the block schema"
                >
                  Display
                </button>
                <button
                  type="button"
                  disabled
                  title="Overrides are not part of the block schema"
                >
                  Overrides
                </button>
                <button
                  type="button"
                  aria-current={tab === "Details" ? "page" : undefined}
                  onClick={() => nav.go("d188")}
                >
                  Details
                </button>
              </nav>
            </Card>
            {tab === "Details" ? (
              <>
                <Card title="Details">
                  <Field
                    label="ID"
                    value={p?.key ?? "—"}
                    why="The parameter key in the block schema"
                  />
                  <div className="fxn-row" style={{ alignItems: "end" }}>
                    <Field
                      label="Block"
                      value={blk?.type ?? "—"}
                      why="The workflow block this parameter belongs to"
                    />
                    <button
                      type="button"
                      className="fxn-btn"
                      aria-label="Copy block type"
                      disabled={!blk}
                      title={blk ? "Copy block type" : "Block not loaded"}
                      onClick={() =>
                        blk && void navigator.clipboard?.writeText(blk.type)
                      }
                    >
                      {Ii("clipboard", 16, "#404854")}
                    </button>
                  </div>
                </Card>
                <Card title="Typeclasses">
                  <div className="fxn-item">
                    <span>placeholder</span>
                    <span aria-hidden>:</span>
                    <span>{dash(p?.placeholder)}</span>
                  </div>
                  <div>
                    <Btn
                      icon="add"
                      why="Typeclasses are fixed by the block schema"
                    >
                      Add new type class
                    </Btn>
                  </div>
                </Card>
              </>
            ) : (
              <>
                <Card title="General">
                  <div className="fxn-tiles">
                    <div className="fxn-tile">
                      <div className="fxn-tile-h">
                        <span>Visible</span>
                        <Switch on label="Visible" why={WHY_SCHEMA} />
                      </div>
                      <div>
                        <Btn icon="refresh" why={WHY_SCHEMA}>
                          Add override
                        </Btn>
                      </div>
                    </div>
                    <div className="fxn-tile">
                      <div className="fxn-tile-h">
                        <span>Disabled</span>
                        <Switch on={false} label="Disabled" why={WHY_SCHEMA} />
                      </div>
                    </div>
                    <div className="fxn-tile">
                      {/* Required = the block schema's required flag */}
                      <div className="fxn-tile-h">
                        <span>Required</span>
                        <Switch on={req} label="Required" why={WHY_SCHEMA} />
                      </div>
                      <div>
                        <Btn icon="refresh" why={WHY_SCHEMA}>
                          Add override
                        </Btn>
                      </div>
                    </div>
                  </div>
                </Card>
                <Card title="Constraints">
                  <div className="fxn-toggle-row">
                    <div>
                      <div>Allow multiple values</div>
                      <p className="fxn-p">
                        Users will be able to select more than one{" "}
                        {p?.type ?? "value"}
                      </p>
                    </div>
                    <Switch
                      on={false}
                      label="Allow multiple values"
                      why={WHY_SCHEMA}
                    />
                  </div>
                  <div className="fxn-tiles">
                    {(
                      [
                        ["User input", "annotation", true],
                        ["Multiple choice", "properties", false],
                        ["User", "user", false],
                        ["Group", "people", false],
                      ] as const
                    ).map(([lab, ic, on]) => (
                      <div
                        key={lab}
                        className={on ? "fxn-tile on" : "fxn-tile"}
                        title={on ? undefined : WHY_SCHEMA}
                      >
                        <div className="fxn-tile-h">
                          <span>
                            {Ii(ic, 16, on ? "#215db0" : "#5f6b7c")} {lab}
                          </span>
                          {on ? Ii("tick", 16, "#2d72d2") : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  {[
                    "With minimum length",
                    "With maximum length",
                    "Matching regex",
                  ].map((lab) => (
                    <label key={lab} className="fxn-chk" title={WHY_SCHEMA}>
                      <input type="checkbox" disabled />
                      {lab}
                    </label>
                  ))}
                </Card>
                <Card title="Default value">
                  <div className="fxn-toggle-row">
                    <p className="fxn-p">
                      Set a default value for the input. It can be overridden by
                      users.
                    </p>
                    <Switch on={false} label="Default value" why={WHY_SCHEMA} />
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}

export const D188 = ({ nav }: { nav: Nav }): JSX.Element => (
  <ParamPage nav={nav} tab="Details" />
);
export const D189 = ({ nav }: { nav: Nav }): JSX.Element => (
  <ParamPage nav={nav} tab="Value" />
);
