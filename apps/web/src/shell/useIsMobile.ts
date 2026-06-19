import { useEffect, useState } from 'react';

// True on narrow (phone) viewports. Used by ConsoleShell to switch between the
// desktop rail layout and the mobile hamburger/panel-chooser — rendered
// exclusively (never both) so panel components like Timeline mount only once.
export function useIsMobile(query = '(max-width: 767px)'): boolean {
  const [match, setMatch] = useState<boolean>(
    () => typeof matchMedia !== 'undefined' && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(query);
    const onChange = (): void => setMatch(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}
