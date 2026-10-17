import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePhoneSheet } from "./phoneSheet.js";
import { useIsMobile } from "./useIsMobile.js";

/** A banner that belongs in the Notices sheet on a phone. On a desktop it
 *  renders where it stands. On a phone it is counted for the title bar's chip
 *  and drawn into the sheet: three banners stacked over a 412px map took a
 *  third of it (measured 2026-10-17: low-end, OpenSky and open-mode, 300px).
 *  Wrap the banner's own markup, after its early returns, so a banner that
 *  decided not to show is never counted. */
export function PhoneNotice({ children }: { children: ReactNode }) {
  const phone = useIsMobile();
  const host = usePhoneSheet((s) => s.noticeHost);
  const addNotice = usePhoneSheet((s) => s.addNotice);
  useEffect(() => (phone ? addNotice() : undefined), [phone, addNotice]);
  if (!phone) return <>{children}</>;
  return host ? createPortal(children, host) : null;
}
