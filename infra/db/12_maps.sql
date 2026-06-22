-- ============================================================================
-- Velocity shared named COP — saved maps (Track D2)
-- A saved map is NOT a new table: it is an `objects` row (kind stays 'object',
-- props->>kind = 'map') persisted via the ontology registry, so it inherits the
-- objects table's RLS (auth.uid() = user_id) verbatim. This migration only adds
-- a partial index so listing a user's maps (props->>kind = 'map', newest first)
-- stays fast as the ontology grows alerts / investigations / flagged entities.
-- Idempotent: safe to re-run. Depends on 10_ontology.sql (public.objects).
-- Apply via the Supabase SQL editor / MCP (the operator applies; the backend
-- never runs DDL). The /ws/cop follow-along channel is purely in-process and
-- persists nothing, so it needs no schema.
-- ============================================================================

-- List query is: user_id = $me AND props->>'kind' = 'map' ORDER BY created_at.
-- A partial btree on (user_id, created_at desc) WHERE the row is a map keeps that
-- query off a full per-user scan once a user accumulates many ontology objects.
create index if not exists objects_user_map_idx
  on public.objects (user_id, created_at desc)
  where (props->>'kind') = 'map';
