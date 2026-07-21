export interface WhatsWrong { source: string; technique: string; quote: string; }
export interface Proof { source: string; url: string; published: string; }
export interface SupportingDoc {
  kind: 'incident' | 'satellite';
  url?: string; caption?: string;
  incident_id?: string; threat_level?: string; narrative?: string;
  centroid?: { lon: number; lat: number };
}
// Verifier ensemble output for one story (apps/api/app/news/verify.py). Every
// field is optional — a story is verified best-effort and may still carry
// none of this (verification skipped: no local models installed, budget
// exhausted, etc).
export type VerificationStatus =
  | 'verified-neutral' | 'reviewed-revised' | 'contested' | 'reviewed' | 'unverified';
export interface Diversity { outlets: number; buckets: string[]; }
export interface Verification {
  status?: VerificationStatus;
  models?: string[];
  verdicts?: number;
  diversity?: Diversity;
  skipped?: string;
  note?: string;
  flags?: unknown[];
}
export interface BiasReview {
  original: { title?: string; neutral_summary?: string };
  flags: unknown;
}
export interface Story {
  id: string;
  category: string;
  title: string;
  image: string;
  neutral_summary: string;
  neutral_rewrite: string;
  corroboration: { source_count: number; sources: string[] };
  verified_facts: string[];
  attributed_claims: { who: string; claim: string; status: string }[];
  whats_wrong: WhatsWrong[];
  propaganda_techniques: string[];
  rhetoric_flags: { who: string; claim: string; note: string }[];
  recommended_actions: string[];
  proofs: Proof[];
  supporting_docs: SupportingDoc[];
  confidence: number;
  verification?: Verification;
  bias_review?: BiasReview;
  countries?: string[];
  /** Present only when a source region grouping exists upstream (it does
   * not, as of this edition shape — kept optional so a future backend can
   * add it without another type change). */
  region?: string;
}
export interface EditionVerification {
  models: string[];
  stories_verified?: number;
  stories_flagged?: number;
  budget_exhausted?: boolean;
  errors?: string[];
  skipped?: boolean;
}
export interface Edition {
  generated: string | null;
  categories: string[];
  lead: Story | null;
  stories: Story[];
  method: string;
  backend: string | null;
  article_count: number;
  source_count: number;
  verification?: EditionVerification;
}

// GET /api/news/brief
export interface BriefFreshness {
  articles_age_s?: number | null;
  feeds_fetched?: number | null;
  feeds_total?: number | null;
  verified_count?: number | null;
}
export interface BriefTopStory {
  title?: string;
  link?: string | null;
  category?: string;
  corroboration?: { source_count: number; sources: string[] };
  confidence?: number;
}
export interface Brief {
  generated_utc: string;
  categories: string[];
  top: BriefTopStory[];
  synthesis: string;
  synthesis_error: string;
  freshness: BriefFreshness;
}

// GET /api/news/feed — apps/api/app/routes/news.py:_articles_payload
export interface FeedArticle {
  title: string;
  summary: string;
  link: string;
  source: string;
  leaning: string | null;
  published: string | null;
}
export interface FeedResponse {
  count: number;
  articles: FeedArticle[];
}
