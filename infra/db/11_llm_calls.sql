-- ============================================================================
-- Velocity LLM observability — per-user llm_calls (Track D3)
-- One row per app/llm.py chat() completion: which model answered, how many
-- tokens it cost, how long it took, how many tool calls the turn carried.
-- Per-user, RLS-scoped exactly like objects / links / action_log / user_keys.
-- Idempotent: safe to re-run. Apply via Supabase SQL editor / MCP (the operator
-- applies; the backend never runs DDL).
-- ============================================================================

-- ---- llm_calls: observability log (append-only from the app) ----------------
-- Written best-effort from llm.chat() via the caller's own Supabase token, so
-- RLS (auth.uid() = user_id) scopes every row to the user who made the call.
-- A call with no user token in context is simply NOT logged (the backend has no
-- service-role key here and RLS forbids a NULL-owner insert) — logging degrades
-- silently and NEVER blocks or fails the LLM call.
--
-- Columns:
--   backend        deepseek | minimax | ollama | NULL (which slot answered)
--   model_id       the concrete model id that ran (e.g. deepseek-chat)
--   tier           the requested tier (fast | reason)
--   ok             did the call return text
--   prompt_tokens / completion_tokens / total_tokens — from LlmResult.usage
--                  (the OpenAI-compatible `usage` block; 0 when the backend
--                  omits it, e.g. Ollama)
--   latency_ms     wall-clock of the chat() call
--   tool_calls     number of tool calls the turn carried (0 for plain chat)
--   label          optional caller tag (e.g. 'investigate', 'agent.gather',
--                  'sim.reason') so calls can be grouped by feature
--   error          truncated upstream error when ok = false
create table if not exists public.llm_calls (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  backend           text,
  model_id          text,
  tier              text,
  ok                boolean not null default false,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  latency_ms        int not null default 0,
  tool_calls        int not null default 0,
  label             text not null default '',
  error             text,
  ts                timestamptz not null default now()
);

-- Most reads are "this user's recent calls"; index user + time desc.
create index if not exists llm_calls_user_ts_idx on public.llm_calls (user_id, ts desc);
-- Cost/usage roll-ups group by model; index user + model.
create index if not exists llm_calls_user_model_idx on public.llm_calls (user_id, model_id);

alter table public.llm_calls enable row level security;

drop policy if exists llm_calls_self_select on public.llm_calls;
drop policy if exists llm_calls_self_insert on public.llm_calls;

create policy llm_calls_self_select on public.llm_calls for select using (auth.uid() = user_id);
create policy llm_calls_self_insert on public.llm_calls for insert with check (auth.uid() = user_id);

-- Append-only from the app: grant insert + select, NOT update/delete.
grant select, insert on public.llm_calls to authenticated;
