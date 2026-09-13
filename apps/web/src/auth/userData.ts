// What a sign-out leaves behind in this browser (ASVS V14.3.1).
//
// Investigation work (pinned captures with coordinates, saved searches, tasking
// questions, inbox triage, map drawings) is the signed-in user's data and must
// not wait on a shared machine for the next person. Device preferences (theme,
// rail widths, dismissed banners, the tour) belong to the machine and stay, so
// signing out does not also reset the console someone arranged.
//
// Every storage key the app writes is listed in exactly one of the two lists;
// userData.test.ts scans src/ and fails on a key that is in neither.
import { useCaptures } from '../state/captures.js';
import { useSavedSearches } from '../state/savedSearches.js';
import { useTaskingQuestions } from '../state/taskingQuestions.js';
import { useInbox } from '../state/inbox.js';
import { useAnnotations } from '../annotations/annotationStore.js';

export const USER_DATA_KEYS = [
  'velocity.captures',
  'velocity.savedSearches',
  'velocity.taskingQuestions',
  'velocity.inbox.read',
  'velocity.inbox.archived',
  'osint.annotations',
] as const;

export const DEVICE_PREF_KEYS = [
  'velocity.settings',
  'velocity.theme',
  'velocity.dashboardMode',
  'velocity.appView',
  'velocity.aiSetupSeen',
  'velocity.onboarded.v1',
  'velocity.degradedDismissed',
  'velocity.lowEndDismissed',
  'velocity.openModeDismissed',
  'csl.leftW',
  'csl.rightW',
] as const;

/** Empty the in-memory stores, then remove their persisted copies. The order
 *  matters for annotations: its persist middleware rewrites the key on set. */
export function clearUserData(): void {
  useCaptures.setState({ captures: [] });
  useSavedSearches.setState({ searches: [] });
  useTaskingQuestions.setState({ questions: [] });
  useInbox.setState({ read: new Set(), archived: new Set() });
  useAnnotations.setState({ annotations: [], past: [], future: [] });
  try {
    for (const k of USER_DATA_KEYS) localStorage.removeItem(k);
  } catch {
    /* storage blocked → nothing persisted */
  }
}
