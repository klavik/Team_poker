-- Planning Poker для Supabase
-- Выполните файл целиком в Supabase Dashboard → SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  email text not null check (email = lower(email)),
  display_name text not null check (char_length(display_name) between 1 and 150),
  role text not null default 'member' check (role in ('lead', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (team_id, email)
);

-- Миграция со старой версии: нормализуем email и заменяем
-- индекс на вариант, подходящий для PostgREST upsert(onConflict).
update public.team_members
set email = lower(email)
where email <> lower(email);

drop index if exists public.team_members_team_email_uq;
create unique index if not exists team_members_team_email_uq
  on public.team_members(team_id, email);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 150),
  iteration text,
  status text not null default 'active'
    check (status in ('draft', 'active', 'finished')),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  gitlab_url text,
  description text,
  current_round integer not null default 1 check (current_round >= 1),
  status text not null default 'pending'
    check (status in ('pending', 'voting', 'revealed', 'estimated')),
  final_estimate numeric(6, 2),
  sort_order integer not null default 0,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  round integer not null check (round >= 1),
  user_id uuid not null default auth.uid(),
  voter_email text not null check (voter_email = lower(voter_email)),
  value numeric(6, 2) not null check (value in (0.5, 1, 2, 3, 5, 8, 13)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issue_id, round, user_id)
);

create or replace function public.current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_team_member(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members tm
    where tm.team_id = p_team_id
      and tm.active = true
      and tm.email = public.current_user_email()
  );
$$;

create or replace function public.is_team_lead(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = p_team_id
        and tm.active = true
        and tm.role = 'lead'
        and tm.email = public.current_user_email()
    )
    or exists (
      select 1
      from public.teams t
      where t.id = p_team_id
        and t.created_by = auth.uid()
    );
$$;

create or replace function public.issue_team_id(p_issue_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.team_id
  from public.issues i
  join public.sessions s on s.id = i.session_id
  where i.id = p_issue_id;
$$;

create or replace function public.can_access_issue(p_issue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_team_member(public.issue_team_id(p_issue_id))
    or public.is_team_lead(public.issue_team_id(p_issue_id));
$$;

create or replace function public.issue_is_revealed(p_issue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.issues i
    where i.id = p_issue_id
      and i.status in ('revealed', 'estimated')
  );
$$;

create or replace function public.can_vote_issue(p_issue_id uuid, p_round integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.can_access_issue(p_issue_id)
    and exists (
      select 1
      from public.issues i
      where i.id = p_issue_id
        and i.status = 'voting'
        and i.current_round = p_round
    );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists issues_set_updated_at on public.issues;
create trigger issues_set_updated_at
before update on public.issues
for each row execute function public.set_updated_at();

drop trigger if exists votes_set_updated_at on public.votes;
create trigger votes_set_updated_at
before update on public.votes
for each row execute function public.set_updated_at();

create or replace function public.get_vote_progress(p_issue_id uuid)
returns table(total_votes bigint, eligible_members bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round integer;
  v_team_id uuid;
begin
  if not public.can_access_issue(p_issue_id) then
    raise exception 'Access denied';
  end if;

  select i.current_round, s.team_id
  into v_round, v_team_id
  from public.issues i
  join public.sessions s on s.id = i.session_id
  where i.id = p_issue_id;

  return query
  select
    (
      select count(*)
      from public.votes v
      where v.issue_id = p_issue_id
        and v.round = v_round
    ),
    (
      select count(*)
      from public.team_members tm
      where tm.team_id = v_team_id
        and tm.active = true
    );
end;
$$;

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.sessions enable row level security;
alter table public.issues enable row level security;
alter table public.votes enable row level security;

drop policy if exists teams_select on public.teams;
create policy teams_select
on public.teams
for select
to authenticated
using (
  created_by = auth.uid()
  or public.is_team_member(id)
);

drop policy if exists teams_insert on public.teams;
create policy teams_insert
on public.teams
for insert
to authenticated
with check (created_by = auth.uid());

drop policy if exists teams_update on public.teams;
create policy teams_update
on public.teams
for update
to authenticated
using (public.is_team_lead(id))
with check (public.is_team_lead(id));

drop policy if exists teams_delete on public.teams;
create policy teams_delete
on public.teams
for delete
to authenticated
using (public.is_team_lead(id));

drop policy if exists members_select on public.team_members;
create policy members_select
on public.team_members
for select
to authenticated
using (
  public.is_team_member(team_id)
  or public.is_team_lead(team_id)
);

drop policy if exists members_insert on public.team_members;
create policy members_insert
on public.team_members
for insert
to authenticated
with check (public.is_team_lead(team_id));

drop policy if exists members_update on public.team_members;
create policy members_update
on public.team_members
for update
to authenticated
using (public.is_team_lead(team_id))
with check (public.is_team_lead(team_id));

drop policy if exists members_delete on public.team_members;
create policy members_delete
on public.team_members
for delete
to authenticated
using (public.is_team_lead(team_id));

drop policy if exists sessions_select on public.sessions;
create policy sessions_select
on public.sessions
for select
to authenticated
using (
  public.is_team_member(team_id)
  or public.is_team_lead(team_id)
);

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert
on public.sessions
for insert
to authenticated
with check (
  public.is_team_lead(team_id)
  and created_by = auth.uid()
);

drop policy if exists sessions_update on public.sessions;
create policy sessions_update
on public.sessions
for update
to authenticated
using (public.is_team_lead(team_id))
with check (public.is_team_lead(team_id));

drop policy if exists sessions_delete on public.sessions;
create policy sessions_delete
on public.sessions
for delete
to authenticated
using (public.is_team_lead(team_id));

drop policy if exists issues_select on public.issues;
create policy issues_select
on public.issues
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and (
        public.is_team_member(s.team_id)
        or public.is_team_lead(s.team_id)
      )
  )
);

drop policy if exists issues_insert on public.issues;
create policy issues_insert
on public.issues
for insert
to authenticated
with check (
  created_by = auth.uid()
  and exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and public.is_team_lead(s.team_id)
  )
);

drop policy if exists issues_update on public.issues;
create policy issues_update
on public.issues
for update
to authenticated
using (
  exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and public.is_team_lead(s.team_id)
  )
)
with check (
  exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and public.is_team_lead(s.team_id)
  )
);

drop policy if exists issues_delete on public.issues;
create policy issues_delete
on public.issues
for delete
to authenticated
using (
  exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and public.is_team_lead(s.team_id)
  )
);

drop policy if exists votes_select on public.votes;
create policy votes_select
on public.votes
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    public.can_access_issue(issue_id)
    and public.issue_is_revealed(issue_id)
  )
);

drop policy if exists votes_insert on public.votes;
create policy votes_insert
on public.votes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and voter_email = public.current_user_email()
  and public.can_vote_issue(issue_id, round)
);

drop policy if exists votes_update on public.votes;
create policy votes_update
on public.votes
for update
to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and voter_email = public.current_user_email()
  and public.can_vote_issue(issue_id, round)
);

drop policy if exists votes_delete on public.votes;
create policy votes_delete
on public.votes
for delete
to authenticated
using (user_id = auth.uid());

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.teams to authenticated;
grant select, insert, update, delete on public.team_members to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select, insert, update, delete on public.issues to authenticated;
grant select, insert, update, delete on public.votes to authenticated;

grant execute on function public.current_user_email() to authenticated;
grant execute on function public.is_team_member(uuid) to authenticated;
grant execute on function public.is_team_lead(uuid) to authenticated;
grant execute on function public.issue_team_id(uuid) to authenticated;
grant execute on function public.can_access_issue(uuid) to authenticated;
grant execute on function public.issue_is_revealed(uuid) to authenticated;
grant execute on function public.can_vote_issue(uuid, integer) to authenticated;
grant execute on function public.get_vote_progress(uuid) to authenticated;

revoke all on function public.current_user_email() from public, anon;
revoke all on function public.is_team_member(uuid) from public, anon;
revoke all on function public.is_team_lead(uuid) from public, anon;
revoke all on function public.issue_team_id(uuid) from public, anon;
revoke all on function public.can_access_issue(uuid) from public, anon;
revoke all on function public.issue_is_revealed(uuid) from public, anon;
revoke all on function public.can_vote_issue(uuid, integer) from public, anon;
revoke all on function public.get_vote_progress(uuid) from public, anon;
