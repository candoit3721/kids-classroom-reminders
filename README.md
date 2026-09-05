# Kids Classroom Reminders

A kid-friendly daily page for two Lauremont students, built from Google
Classroom posts and the school calendar.

**The page** is one static HTML file. **The data** lives in Supabase. **The
collector** is a Claude scheduled task that reads Classroom three times a day.

```
Google Classroom ──(Claude in Chrome, 3x/day)──> raw_items
                                                    │ extract
                                                    ▼
   school calendar PDF ──> day_cycle ──────────> events ──> index.html
                           school_events
```

## Layout

| Path | What it is |
|---|---|
| `index.html` | entry page — both kids |
| `sophia/index.html`, `olivia/index.html` | per-kid entry pages |
| `app.css`, `app.js` | the whole app, shared by all three pages |
| `db/schema.sql` | reference snapshot of the schema (live DB is the source of truth) |
| `docs/collector-spec.md` | the contract the scheduled collector follows |
| `oauth/` | the blocked Google API path, kept for later (secrets git-ignored) |

## Deploy to GitHub Pages

```bash
git remote add origin git@github.com:<you>/kids-classroom-reminders.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → main / (root)**.
Live in about a minute. Pages serves it with no config, no Actions workflow
and no build.

## URLs

| URL | Shows |
|---|---|
| `calendar.studyflix.vip/` | both kids, each card tagged with a name |
| `calendar.studyflix.vip/sophia` | Sophia only |
| `calendar.studyflix.vip/olivia` | Olivia only |

Which kid is shown comes from the last path segment; anything unrecognised
falls back to both. There is no in-page switcher — give each kid their own
bookmark. Pages redirects `/sophia` to `/sophia/` automatically.

**HTTPS on the custom domain** needs a specific DNS record for the subdomain —
a wildcard `*.studyflix.vip` resolves, so GitHub's DNS check passes, but
Let's Encrypt will not issue a certificate through a wildcard. Required:

    CNAME   calendar   candoit3721.github.io

After adding it, remove and re-add the domain in Pages settings to retrigger
certificate provisioning, then tick **Enforce HTTPS**.

## Configuration

Everything adjustable is at the top of the `<script>` block in `index.html`:

| Constant | Purpose |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | which project to read |
| `TZ` | `America/Toronto` |
| `HORIZON_DAYS` | how far "Coming up" looks ahead (21) |

Kid names and colours come from the database, not the file:

```sql
update kids set display_name = 'Olivia', slug = 'olivia' where slug = 'sibling';
```

Per-kid accent colours are keyed off the slug in CSS —
`:root[data-kid="sibling"]` teal, `[data-kid="both"]` amber, default violet.

## Data access

The browser reads four owner-owned views and never the base tables:

- `v_public_kids` — names, grades, themes (never `view_token`)
- `v_public_agenda` — published, non-superseded events, −7 to +120 days
- `v_public_school_events` — kid-facing school calendar entries
- `v_public_day_cycle` — Day 1–8 numbers and closures
- `v_public_status` — collector freshness: last success, next scheduled run,
  and whether the last scheduled slot actually ran

Base tables have RLS enabled with no policies, so the anon key returns zero
rows from them. Nothing in the page can write.

## Privacy

The published page is public: anyone with the URL can see the kids' names and
schedule. No addresses, grades or contact details are exposed. To lock it down
later, `kids.view_token` already exists — add a `security definer` function
that takes the token and read it from the query string.

## Operating notes

- Collector: scheduled task **"Classroom collector (3x daily)"**, 6am / 4pm / 8pm
  Toronto. After the November time change it drifts to 5am / 3pm / 7pm.
- New and materially-changed events land as `pending` — approve them before
  they reach the kids. `select * from v_review_queue;`
- "Done" ticks live in each browser's `localStorage`; they are per-device and
  are not written back to the database.
- The footer shows a quiet freshness line ("Checked 2 hours ago") with a green
  dot; it turns amber when a scheduled run was missed. Tap it for the detail.
  If you change the schedule, update `collector_schedule` to match.
- The school calendar is loaded through **June 18, 2027** (173 school days).
  Next August, re-run the calendar ingest for the new year.
