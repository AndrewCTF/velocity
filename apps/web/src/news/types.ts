export interface WhatsWrong { source: string; technique: string; quote: string; }
export interface Proof { source: string; url: string; published: string; }
export interface SupportingDoc {
  kind: 'incident' | 'satellite';
  url?: string; caption?: string;
  incident_id?: string; threat_level?: string; narrative?: string;
  centroid?: { lon: number; lat: number };
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
}
