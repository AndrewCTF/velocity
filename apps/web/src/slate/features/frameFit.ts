// The copy pages were tuned against their reference frames in a 1920x1080
// window, whose map well (the app surface under Slate's bars) is 1878x988. A
// larger window shows a page at that size, centred, instead of zooming every
// glyph past the shell's own type (2.2x on a 2560x1440 screen); a smaller
// window still shrinks it to fit.
export const REF_WELL: readonly [number, number] = [1878, 988];

/** CSS zoom for a W x H frame in a cw x ch host. */
export function frameZoom(cw: number, ch: number, W: number, H: number): number {
  return Math.min(cw / W, ch / H, REF_WELL[0] / W, REF_WELL[1] / H);
}
