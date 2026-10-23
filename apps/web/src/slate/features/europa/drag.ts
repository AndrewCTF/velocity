// The artifact being dragged out of a Europa page (the Gaia evidence rows set
// it), so the chat drop zone can draw its chip: a dragover event cannot read
// the payload, only its types.
let current: string | null = null;
export const setDragTitle = (t: string | null): void => {
  current = t;
};
export const dragTitle = (): string | null => current;
