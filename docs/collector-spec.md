# Collector & extractor spec — Kids Classroom Reminders

Project: `eusazkbcvscjxwpmddtp` · Timezone: America/Toronto

The daily Cowork task follows this contract. The database enforces the tricky
parts through functions, so the task can't produce duplicates even if it re-reads
everything.

---

## 1. Identity — how a post is recognised across days

| Concept | Column | Changes when |
|---|---|---|
| Identity | `raw_items.source_key` | never |
| Version | `raw_items.content_hash` | the teacher edits the post |
| Liveness | `last_seen_at` / `missing_runs` / `deleted_at` | the post disappears |

`source_key` is the Classroom post id, taken from the post's own permalink:

- `.../c/<course>/a/<POSTID>/details` → assignment → `POSTID`
- `.../c/<course>/m/<POSTID>/details` → material → `POSTID`
- stream announcements → use the post's **Copy link** permalink (`/p/<POSTID>`)

**Collector requirement:** for stream announcements, always open the post's
⋮ menu → *Copy link* to get a per-post permalink. Do not fall back to the class
URL. Without a stable id, an edited announcement looks like a brand new post.
If a permalink genuinely can't be obtained, synthesise
`syn:<class_id>:<slugified title>` — stable as long as the title doesn't change.

---

## 2. What to collect each run

Do **not** re-read the entire year every day. The active set is:

1. Every post on the **first page** of each class stream (catches anything new).
2. Every `raw_items` row where `watch = true` and `deleted_at is null` and
   (`posted_at > now() - 45 days` **or** it has a live event dated in the future).
3. Anything the previous run flagged as low confidence.

Attachments are the slow part. Only open a Slides/Doc/PDF attachment when the
post's `content_hash` **or** `attachments_hash` changed, or the row is new.
Otherwise reuse the stored `attachments` JSON.

Set `watch = false` on posts that are pure archive (e.g. last term's material)
to keep the daily run bounded as the year goes on.

---

## 3. Writing raw items

One call per post seen — never a raw INSERT:

```sql
select * from upsert_raw_item(
  p_kid_slug   => 'sophia',
  p_class_name => 'Class 318 (2026/2027)',
  p_source_key => 'ODc3MTEzNzg0NjYx',
  p_kind       => 'assignment',           -- announcement | assignment | material
  p_title      => '...',
  p_body       => '...',                  -- full post text
  p_attachments=> '[{"title":"...","type":"slides","url":"...","extracted_text":"..."}]'::jsonb,
  p_source_url => 'https://classroom.google.com/u/1/c/.../a/.../details',
  p_posted_at  => '2026-09-02T12:00:00-04:00',
  p_run_id     => :run_id);
```

Returns `out_action` = `created` | `changed` | `unchanged`.

- `unchanged` → nothing else to do; liveness is refreshed.
- `changed` → previous text is archived to `raw_item_versions`, `revision` bumps,
  `last_changed_at` set. **Must be re-extracted this run.**
- `created` → new post. Must be extracted.

Also record what was visible, per class, so deletions can be detected safely:

```sql
insert into class_scans (run_id, class_id, ok, items_seen, source_keys)
values (:run_id, :class_id, true, 12, array['ODc3...','ODc2...']);
```

**Only set `ok = true` if the class page actually loaded and rendered.** A failed
scrape recorded as OK would retire real events.

---

## 4. What gets re-extracted

```sql
select * from raw_items
where deleted_at is null
  and (extracted_at is null
       or last_changed_at > extracted_at
       or extractor_version is distinct from 'v2');
```

New posts, edited posts, and everything when the prompt is improved. Nothing else.
An unchanged post is never sent to the model twice — that's the cost control.

---

## 5. Extraction contract

For each raw item, the model returns a JSON array. Every event carries an
`activity_key`: a short, stable slug for *the thing itself*, not its date.

```json
[
  {
    "activity_key": "basketball-tryout-2",
    "event_date": "2026-09-11",
    "start_time": "15:45",
    "end_time": "17:00",
    "type": "tryout",
    "kid_title": "Basketball tryout #2",
    "icon": "🏀",
    "parent_detail": "U12 Girls Basketball tryout 2 of 3. No Kiss and Go.",
    "confidence": 0.95
  }
]
```

Rules the prompt must state explicitly:

- `activity_key` **must stay identical** across re-extractions of the same post.
  It is what makes "tryout 2 moved to Monday" an update rather than a new event.
  Never put a date inside the key.
- `kid_title`: max ~6 words, second person, plain language a 8-year-old reads.
- `parent_detail`: the fuller context, for Henry.
- `type`: `due | bring | test | tryout | practice | form | gym | trip | info`
- Emit **nothing** for information with no date and no action.
- Resolve relative dates against the post's `posted_at` and the school calendar;
  if the post says "Day 5", leave `event_date` null and set
  `"cycle_day": 5` instead — the DB resolves it via `day_cycle`.
- `confidence` below 0.7 for anything inferred rather than stated.

Then one call per event:

```sql
select * from upsert_event(
  p_kid_slug   => 'sophia',
  p_dedupe_key => :raw_item_id || ':' || :activity_key,
  p_event_date => '2026-09-11', ... );
```

Returns `out_action` = `created` | `updated` | `unchanged`, plus `out_material`.
A change to date, time or type is **material**: the event is flipped back to
`pending` and `needs_review = true`, so a moved tryout can't reach the kids
without your nod. A wording-only change updates silently.

Finally, retire what this post no longer produces:

```sql
select supersede_missing_events(:raw_item_id, :all_dedupe_keys_from_this_extraction, :run_id);
```

> ⚠️ **Pass the complete key set from a full extraction.** If extraction fails
> halfway and you call this with a partial list, every event not in that list is
> superseded. On any extraction error, skip this call entirely.

---

## 6. End of run

```sql
select expand_recurring_rules();      -- gym/library/French, 60 days out, idempotent
select reconcile_deletions(:run_id);  -- retire posts missing 2 runs in a row
update collection_runs set finished_at = now(), status = 'ok', ... where id = :run_id;
```

`reconcile_deletions` only counts a post as missing if the class it lives in was
scanned with `ok = true`, and waits for two consecutive misses. Both guards exist
because Classroom lazy-loads, and one slow page must not wipe a week of events.

---

## 7. Daily digest

```sql
select action, material, summary from change_log
where created_at > now() - interval '24 hours' order by material desc, created_at;

select * from v_review_queue;   -- pending + materially changed, awaiting approval
```

Push to Henry only when something is `material` or the review queue is non-empty.
A quiet day should produce no notification.

---

## 8. What the app reads

```sql
select * from v_kid_upcoming where kid_slug = 'sophia' order by event_date, start_time;
```

`v_kid_upcoming` is already filtered to `status='published'`,
`superseded_at is null`, and `event_date >= today`. Past and retired events stay
in the table for history but are never fetched. No client-side filtering needed.
