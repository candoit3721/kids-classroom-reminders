-- Gender-aware events.
--
-- Some of what the school posts is for boys only or girls only (U12 Boys
-- Volleyball, U12 Girls Basketball). Each kid records a gender - M, F, or
-- N/A when not shared - and any event the school restricts by gender is
-- flagged with audience_gender. Reads filter on the pair: an unflagged event
-- shows for everyone, a flagged one only for a matching kid, and a kid with
-- N/A sees both kinds. The flag is captured at collection time; the filter
-- runs at read time, so changing a kid's setting takes effect immediately.

-- 1. columns ---------------------------------------------------------------
alter table public.kids add column if not exists gender text not null default 'N/A';
alter table public.kids drop constraint if exists kids_gender_check;
alter table public.kids add constraint kids_gender_check check (gender in ('M','F','N/A'));
comment on column public.kids.gender is 'M, F, or N/A when not shared; N/A sees boys-only and girls-only content alike';

alter table public.events add column if not exists audience_gender text;
alter table public.events drop constraint if exists events_audience_gender_check;
alter table public.events add constraint events_audience_gender_check
  check (audience_gender is null or audience_gender in ('M','F'));
comment on column public.events.audience_gender is 'M / F when the school runs this for boys only / girls only; null = everyone';

alter table public.school_events add column if not exists audience_gender text;
alter table public.school_events drop constraint if exists school_events_audience_gender_check;
alter table public.school_events add constraint school_events_audience_gender_check
  check (audience_gender is null or audience_gender in ('M','F'));

-- 2. the one rule, in one place ---------------------------------------------
create or replace function public.gender_ok(p_audience text, p_kid_gender text)
returns boolean language sql immutable as $$
  select p_audience is null or coalesce(p_kid_gender, 'N/A') = 'N/A' or p_audience = p_kid_gender
$$;
comment on function public.gender_ok(text, text) is 'does content flagged p_audience (M/F/null) apply to a kid recorded as p_kid_gender (M/F/N/A)?';

-- 3. public views -----------------------------------------------------------
create or replace view public.v_public_agenda as
 select e.id as event_id, k.slug as kid_slug, e.event_date, e.start_time, e.end_time, e.type,
        e.kid_title, e.icon, e.parent_detail, e.source_url, e.confidence, c.name as class_name
   from events e
   join kids k on k.id = e.kid_id
   left join classes c on c.id = e.class_id
  where e.status = 'published' and e.superseded_at is null
    and e.event_date >= (current_date - 7) and e.event_date <= (current_date + 120)
    and public.gender_ok(e.audience_gender, k.gender);

-- for_kids: which kids a school-wide event applies to (all of them unless it is
-- boys-only / girls-only). The app hides an event none of the kids on screen
-- are in; an event that matches no kid at all is not served.
create or replace view public.v_public_school_events as
 select se.event_date, se.end_date, se.title, se.category, se.audience, se.detail,
        (select array_agg(k.slug order by k.slug) from kids k where public.gender_ok(se.audience_gender, k.gender)) as for_kids
   from school_events se
  where se.kid_facing
    and coalesce(se.end_date, se.event_date) >= (current_date - 7) and se.event_date <= (current_date + 120)
    and exists (select 1 from kids k where public.gender_ok(se.audience_gender, k.gender));

create or replace view public.v_review_queue as
 select e.id as event_id, k.slug as kid_slug, e.event_date, e.start_time, e.type, e.kid_title,
        e.parent_detail, e.source_url, e.confidence, e.status, e.needs_review, e.changed_fields,
        e.revision, e.created_at, e.audience_gender
   from events e join kids k on k.id = e.kid_id
  where e.superseded_at is null and (e.status = 'pending' or e.needs_review)
  order by e.event_date, e.created_at;

-- 4. the agenda Ask reads -----------------------------------------------------
create or replace function public.agenda_window(p_from date, p_to date, p_kid_slug text default null)
returns table(school_date date, day_number integer, kid_slug text, kid_name text, entries jsonb)
language sql stable security definer set search_path to 'public' as $$
  with days as (
    select dc.school_date, dc.day_number, dc.note
    from day_cycle dc
    where dc.school_date between p_from and p_to
  ),
  ks as (
    select k.id, k.slug, k.display_name, k.gender from kids k
    where p_kid_slug is null or k.slug = p_kid_slug
  )
  select d.school_date, d.day_number, ks.slug, ks.display_name,
         coalesce((
           select jsonb_agg(x order by x->>'start_time' nulls last, x->>'title')
           from (
             select jsonb_build_object(
                      'title', e.kid_title, 'type', e.type, 'icon', e.icon,
                      'start_time', e.start_time, 'detail', e.parent_detail,
                      'recurring', e.rule_id is not null, 'url', e.source_url) as x
             from events e
             where e.kid_id = ks.id
               and e.event_date = d.school_date
               and e.superseded_at is null
               and e.status = 'published'
               and gender_ok(e.audience_gender, ks.gender)
             union all
             select jsonb_build_object(
                      'title', se.title, 'type', 'school', 'icon', '🏫',
                      'start_time', null, 'detail', se.detail,
                      'recurring', false, 'url', null)
             from school_events se
             where d.school_date between se.event_date
                                     and coalesce(se.end_date, se.event_date)
               and gender_ok(se.audience_gender, ks.gender)
           ) s(x)
         ), '[]'::jsonb)
  from days d
  cross join ks
  where d.day_number is not null
     or exists (select 1 from school_events se
                 where d.school_date between se.event_date
                                         and coalesce(se.end_date, se.event_date))
  order by d.school_date, ks.slug;
$$;

-- 5. upsert_event learns the flag ---------------------------------------------
-- p_audience_gender: 'M' / 'F' / null (everyone) / 'keep' (default - leave the
-- stored value alone, so an older 14-argument caller cannot wipe a flag).
-- The old signature is dropped first: a second overload would make every
-- 14-argument call ambiguous.
drop function if exists public.upsert_event(text, text, date, text, text, text, text, time without time zone, time without time zone, text, uuid, numeric, text, uuid);

create or replace function public.upsert_event(
  p_kid_slug text, p_dedupe_key text, p_event_date date, p_type text, p_kid_title text,
  p_icon text default null, p_parent_detail text default null,
  p_start_time time without time zone default null, p_end_time time without time zone default null,
  p_source_url text default null, p_raw_item_id uuid default null, p_confidence numeric default 1.00,
  p_extractor text default 'v2', p_run_id uuid default null,
  p_audience_gender text default 'keep')
returns table(out_event_id uuid, out_action text, out_material boolean)
language plpgsql security definer as $function$
declare
  v_kid uuid; v_class uuid; v_old events%rowtype; v_changed text[] := array[]::text[]; v_new uuid; v_mat boolean;
  v_gender text;
begin
  select id into v_kid from kids where slug = p_kid_slug;
  if v_kid is null then raise exception 'unknown kid %', p_kid_slug; end if;
  select class_id into v_class from raw_items where id = p_raw_item_id;

  if p_audience_gender is not null and p_audience_gender not in ('M','F','keep','') then
    raise exception 'audience_gender must be M, F, null or keep (got %)', p_audience_gender;
  end if;

  select * into v_old from events where kid_id = v_kid and dedupe_key = p_dedupe_key;

  if v_old.id is null then
    v_gender := case when p_audience_gender in ('M','F') then p_audience_gender else null end;
    insert into events (kid_id, class_id, raw_item_id, dedupe_key, event_date, start_time, end_time,
                        type, kid_title, icon, parent_detail, source_url, confidence,
                        status, extractor_version, audience_gender)
    values (v_kid, v_class, p_raw_item_id, p_dedupe_key, p_event_date, p_start_time, p_end_time,
            p_type, p_kid_title, p_icon, p_parent_detail, p_source_url, p_confidence,
            'pending', p_extractor, v_gender)
    returning id into v_new;

    insert into change_log (run_id, kid_id, entity, entity_id, action, material, summary)
    values (p_run_id, v_kid, 'event', v_new, 'created', false, p_kid_title || ' on ' || p_event_date);

    out_event_id := v_new; out_action := 'created'; out_material := false; return next; return;
  end if;

  out_event_id := v_old.id;
  v_gender := case when p_audience_gender = 'keep' then v_old.audience_gender
                   when p_audience_gender in ('M','F') then p_audience_gender
                   else null end;

  if v_old.event_date    is distinct from p_event_date    then v_changed := array_append(v_changed,'event_date'); end if;
  if v_old.start_time    is distinct from p_start_time    then v_changed := array_append(v_changed,'start_time'); end if;
  if v_old.end_time      is distinct from p_end_time      then v_changed := array_append(v_changed,'end_time');   end if;
  if v_old.kid_title     is distinct from p_kid_title     then v_changed := array_append(v_changed,'kid_title');  end if;
  if v_old.parent_detail is distinct from p_parent_detail then v_changed := array_append(v_changed,'parent_detail'); end if;
  if v_old.type          is distinct from p_type          then v_changed := array_append(v_changed,'type'); end if;
  if v_old.audience_gender is distinct from v_gender      then v_changed := array_append(v_changed,'audience_gender'); end if;

  if array_length(v_changed,1) is null then
    update events set last_seen_at = now(), superseded_at = null where id = v_old.id;
    out_action := 'unchanged'; out_material := false; return next; return;
  end if;

  v_mat := v_changed && array['event_date','start_time','end_time','type'];
  out_material := v_mat;

  update events set
    event_date = p_event_date, start_time = p_start_time, end_time = p_end_time,
    type = p_type, kid_title = p_kid_title, icon = coalesce(p_icon, icon),
    parent_detail = p_parent_detail, source_url = coalesce(p_source_url, source_url),
    confidence = p_confidence, extractor_version = p_extractor,
    audience_gender = v_gender,
    revision = v_old.revision + 1, changed_fields = v_changed,
    needs_review = v_mat, status = case when v_mat then 'pending' else status end,
    superseded_at = null, last_seen_at = now(), updated_at = now()
  where id = v_old.id;

  insert into change_log (run_id, kid_id, entity, entity_id, action, material, summary, before, after)
  values (p_run_id, v_kid, 'event', v_old.id, 'updated', v_mat,
          case when v_mat then p_kid_title || ': ' || v_old.event_date || ' -> ' || p_event_date
               else 'Wording updated: ' || p_kid_title end,
          jsonb_build_object('date', v_old.event_date, 'start', v_old.start_time, 'title', v_old.kid_title),
          jsonb_build_object('date', p_event_date, 'start', p_start_time, 'title', p_kid_title));

  out_action := 'updated'; return next;
end $function$;

-- 6. the semantic layer only embeds what applies ---------------------------------
-- (the event and school_event loops gain the gender test; everything else as before)
create or replace function public.sync_chunks()
returns table(created integer, changed integer, unchanged integer, retired integer)
language plpgsql security definer set search_path to 'public' as $function$
declare
  r record; a text; piece text; i int;
  c int := 0; ch int := 0; u int := 0; d int := 0;
  live text[] := array[]::text[];
  v_year_start date := date '2026-09-01';
  v_year_end   date := date '2027-06-30';
  pc int; pch int; pu int;
begin
  for r in
    select pf.id, pf.fact, pf.category, pf.source_url, pf.person_id,
           p.display_name, p.full_name, p.role, p.subject, p.kid_id
      from person_facts pf join people p on p.id = pf.person_id
     where pf.active and p.active
  loop
    select out_action into a from upsert_chunk(
      'person_fact', 'person_fact:' || r.id, 0,
      format('%s (%s%s) — %s', r.display_name, coalesce(r.role,'contact'),
             case when r.subject is not null then ', ' || r.subject else '' end, r.fact),
      r.person_id, r.kid_id, null,
      jsonb_build_object('category', r.category, 'full_name', r.full_name),
      r.source_url, r.display_name, null, null, null);
    live := live || ('person_fact:' || r.id);
    if a='created' then c:=c+1; elsif a='changed' then ch:=ch+1; else u:=u+1; end if;
  end loop;

  for r in
    select ri.id, ri.title, ri.body, ri.source_url, ri.kid_id, ri.kind,
           ri.attachments, ri.posted_at, ri.due_at, cl.name as class_name, cl.teacher,
           k.display_name as kid_name,
           (select p.id from people p where lower(p.full_name)=lower(cl.teacher) limit 1) as person_id
      from raw_items ri
      left join classes cl on cl.id = ri.class_id
      left join kids k on k.id = ri.kid_id
     where ri.deleted_at is null
  loop
    i := 0;
    for piece in select * from split_text(btrim(coalesce(r.title,'') || chr(10) || coalesce(r.body,''))) loop
      select out_action into a from upsert_chunk(
        'post', 'raw_item:' || r.id, i,
        format('%s — %s (%s)' || chr(10) || '%s', coalesce(r.kid_name,'School'), coalesce(r.class_name,'class'), r.kind, piece),
        r.person_id, r.kid_id, r.id,
        jsonb_build_object('class', r.class_name, 'teacher', r.teacher, 'post_kind', r.kind),
        r.source_url, r.title, r.posted_at::date, r.due_at::date, null);
      live := live || ('raw_item:' || r.id);
      if a='created' then c:=c+1; elsif a='changed' then ch:=ch+1; else u:=u+1; end if;
      i := i + 1;
    end loop;

    declare att jsonb; att_i int := 0; j int;
    begin
      for att in select * from jsonb_array_elements(coalesce(r.attachments,'[]'::jsonb)) loop
        if coalesce(length(btrim(att->>'extracted_text')),0) > 20
           and (att->>'extracted_text') not like '(%not text-extracted%' then
          j := 0;
          for piece in select * from split_text(att->>'extracted_text') loop
            select out_action into a from upsert_chunk(
              'attachment', 'attachment:' || r.id || ':' || att_i, j,
              format('%s — attachment "%s" on "%s"' || chr(10) || '%s', coalesce(r.kid_name,'School'), att->>'title', r.title, piece),
              r.person_id, r.kid_id, r.id,
              jsonb_build_object('attachment', att->>'title', 'type', att->>'type', 'class', r.class_name, 'post', r.title),
              coalesce(att->>'url', r.source_url), att->>'title', r.posted_at::date, null, null);
            live := live || ('attachment:' || r.id || ':' || att_i);
            if a='created' then c:=c+1; elsif a='changed' then ch:=ch+1; else u:=u+1; end if;
            j := j + 1;
          end loop;
        end if;
        att_i := att_i + 1;
      end loop;
    end;
  end loop;

  for r in
    select rr.id, rr.kid_title, rr.parent_detail, rr.type, rr.cycle_days, rr.start_time,
           rr.starts_on, rr.ends_on, rr.source_url, rr.kid_id, k.display_name as kid_name, cl.name as class_name
      from recurring_rules rr join kids k on k.id = rr.kid_id left join classes cl on cl.id = rr.class_id
     where rr.active
  loop
    select out_action into a from upsert_chunk(
      'rule', 'rule:' || r.id, 0,
      format('%s — recurring: %s. Happens on Day %s of the 8-day cycle%s. %s', r.kid_name, r.kid_title,
             array_to_string(r.cycle_days, ', Day '),
             case when r.start_time is not null then ' at ' || to_char(r.start_time,'HH12:MIam') else '' end,
             coalesce(r.parent_detail,'')),
      null, r.kid_id, null,
      jsonb_build_object('type', r.type, 'cycle_days', r.cycle_days, 'class', r.class_name),
      r.source_url, r.kid_title, coalesce(r.starts_on, v_year_start), coalesce(r.ends_on, v_year_end), r.id);
    live := live || ('rule:' || r.id);
    if a='created' then c:=c+1; elsif a='changed' then ch:=ch+1; else u:=u+1; end if;
  end loop;

  -- one-off events: only those that apply to the kid they belong to
  for r in
    select e.id, e.kid_title, e.parent_detail, e.type, e.event_date, e.start_time, e.source_url, e.kid_id,
           e.audience_gender, k.display_name as kid_name
      from events e join kids k on k.id = e.kid_id
     where e.superseded_at is null and e.rule_id is null
       and gender_ok(e.audience_gender, k.gender)
  loop
    select out_action into a from upsert_chunk(
      'event', 'event:' || r.id, 0,
      format('%s — %s on %s%s. %s', r.kid_name, r.kid_title, to_char(r.event_date,'FMDay FMDD FMMonth YYYY'),
             case when r.start_time is not null then ' at ' || to_char(r.start_time,'HH12:MIam') else '' end,
             coalesce(r.parent_detail,'')),
      null, r.kid_id, null,
      jsonb_build_object('type', r.type, 'event_date', r.event_date, 'audience_gender', r.audience_gender),
      r.source_url, r.kid_title, r.event_date, r.event_date, r.id);
    live := live || ('event:' || r.id);
    if a='created' then c:=c+1; elsif a='changed' then ch:=ch+1; else u:=u+1; end if;
  end loop;

  -- school-wide events: skipped when boys-only / girls-only and no kid matches
  for r in
    select se.id, se.title, se.detail, se.category, se.event_date, se.end_date, se.audience, se.audience_gender
      from school_events se
     where exists (select 1 from kids k where gender_ok(se.audience_gender, k.gender))
  loop
    select out_action into a from upsert_chunk(
      'school_event', 'school_event:' || r.id, 0,
      format('School-wide — %s (%s) on %s%s. %s', r.title, coalesce(r.category,'event'),
             to_char(r.event_date,'FMDay FMDD FMMonth YYYY'),
             case when r.end_date is not null and r.end_date <> r.event_date then ' through ' || to_char(r.end_date,'FMDD FMMonth') else '' end,
             coalesce(r.detail,'')),
      null, null, null,
      jsonb_build_object('category', r.category, 'audience', r.audience, 'event_date', r.event_date, 'audience_gender', r.audience_gender),
      null, r.title, r.event_date, coalesce(r.end_date, r.event_date), r.id);
    live := live || ('school_event:' || r.id);
    if a='created' then c:=c+1; elsif a='changed' then ch:=ch+1; else u:=u+1; end if;
  end loop;

  -- retire only the kinds this function owns; policy chunks belong to sync_portal_chunks
  delete from doc_chunks where kind <> 'policy' and not (source_key = any (live));
  get diagnostics d = row_count;

  select p.created, p.changed, p.unchanged into pc, pch, pu from sync_portal_chunks() p;
  c := c + pc; ch := ch + pch; u := u + pu;

  return query select c, ch, u, d;
end $function$;

-- 7. today's data -------------------------------------------------------------
update public.kids set gender = 'F' where slug in ('sophia', 'olivia');

-- flag what the school already said was boys-only or girls-only; co-ed stays open
update public.events set audience_gender = 'M'
 where superseded_at is null and audience_gender is null
   and (kid_title || ' ' || coalesce(parent_detail,'')) ~* '\mboys?\M'
   and (kid_title || ' ' || coalesce(parent_detail,'')) !~* '\mgirls?\M'
   and (kid_title || ' ' || coalesce(parent_detail,'')) !~* 'co-?ed';
update public.events set audience_gender = 'F'
 where superseded_at is null and audience_gender is null
   and (kid_title || ' ' || coalesce(parent_detail,'')) ~* '\mgirls?\M'
   and (kid_title || ' ' || coalesce(parent_detail,'')) !~* '\mboys?\M'
   and (kid_title || ' ' || coalesce(parent_detail,'')) !~* 'co-?ed';

select * from public.sync_chunks();
