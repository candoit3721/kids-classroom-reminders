# System Architecture Design

Kids Classroom Reminders (*School Day*) is an event-driven, serverless daily schedule and semantic knowledge assistant. This document details the architectural topology, container model, component interactions, end-to-end data pipelines, and security boundaries.

---

## 1. System Context (C4 Level 1)

The system bridges unstructured educational sources (Google Classroom, portal handbooks, school calendar PDFs) and delivers high-fidelity, kid-accessible agendas and parent QA tools.

```mermaid
C4Context
    title System Context Diagram for Kids Classroom Reminders

    Person(sophia, "Sophia", "Student (Grade 6). Uses phone/tablet to check daily uniform, tests, homework.")
    Person(olivia, "Olivia", "Student (Grade 3). Uses phone/tablet to check daily activities and gear.")
    Person(parents, "Parents (Henry)", "Reviews pending schedule changes, sync logs, and queries AI Ask.")

    System(kids_app, "Kids Classroom Reminders", "Serves kid-friendly daily agenda, documents catalog, and Ask AI assistant.")

    System_Ext(google_classroom, "Google Classroom", "Hosts class streams, assignments, teacher announcements, and attached files.")
    System_Ext(school_portal, "School Portal & Drive", "School handbooks, curriculum guides, schedules, and restricted Google Docs.")
    System_Ext(school_calendar, "School Calendar PDF", "Official 8-day cycle calendar, holidays, and professional development days.")
    System_Ext(claude_agent, "Claude Browser Collector", "Automated Cowork scheduled task operating a real browser instance 3× daily.")

    Rel(claude_agent, google_classroom, "Scrapes first page, posts, and visual attachments", "HTTPS / Chrome")
    Rel(claude_agent, school_portal, "Sweeps documents and files", "HTTPS / Chrome")
    Rel(claude_agent, kids_app, "Upserts raw items, events, and runs via RPC", "HTTPS / Postgres")

    Rel(sophia, kids_app, "Views /sophia/ schedule, marks items done", "HTTPS / Mobile Web")
    Rel(olivia, kids_app, "Views /olivia/ schedule, marks items done", "HTTPS / Mobile Web")
    Rel(parents, kids_app, "Views /, checks sync logs, approves items, queries /ask/", "HTTPS / Desktop & Mobile")
```

---

## 2. Container Architecture (C4 Level 2)

The system employs a strict separation of concerns:
- **Presentation Container**: Static, immutable assets hosted on GitHub Pages with zero server-side rendering or build steps.
- **Data & API Container (Supabase)**: Managed PostgreSQL hosting schema, triggers, business rules, and auto-generated PostgREST HTTP endpoints.
- **Edge Compute Container (Supabase Edge Functions)**: Secured runtime executing hybrid semantic search and LLM synthesis.
- **Ingestion Container (Claude in Chrome)**: Headless/scheduled browser executing DOM scraping, multimodal OCR, and stored procedure calls.

```mermaid
graph TB
    subgraph Client["Client Tier (GitHub Pages CDN)"]
        SPA["Static PWA Shell<br/>(index.html, app.css, app.js, a2hs.js)"]
        SophiaPage["/sophia/ Route"]
        OliviaPage["/olivia/ Route"]
        AskPage["/ask/ Route (ask.js)"]
        DocsPage["/documents/ Route (documents.js)"]
    end

    subgraph Edge["Compute Tier (Supabase Edge)"]
        AskFunc["Edge Function: /functions/v1/ask<br/>(Deno / TypeScript)"]
        LLM["AI Model API<br/>(Claude / Gemini / OpenAI)"]
    end

    subgraph Data["Database Tier (Supabase PostgreSQL)"]
        PostgREST["PostgREST REST API<br/>(anon key restricted)"]
        Views["Public Views (Security Definer)<br/>v_public_agenda, v_public_kids, v_public_day_cycle, etc."]
        RLS["Row Level Security (RLS)<br/>Deny-all on base tables"]
        Tables["Base Tables<br/>kids, classes, raw_items, events, recurring_rules, doc_chunks"]
        Procs["Stored Procedures<br/>upsert_raw_item, upsert_event, sync_chunks, agenda_window"]
    end

    subgraph ExternalAgent["Collector Tier (Scheduled Tasks)"]
        CollectorCron["Scheduled Cowork Task<br/>(3× daily: 6am, 4pm, 8pm Toronto)"]
        BrowserSession["Chrome Browser Profiles<br/>(u/1 for Grade 6, u/2 for Grade 3)"]
    end

    SPA --> PostgREST
    SophiaPage --> PostgREST
    OliviaPage --> PostgREST
    DocsPage --> PostgREST
    AskPage --> AskFunc
    AskFunc --> LLM
    AskFunc --> Procs

    PostgREST --> Views
    Views --> Tables
    Tables -.->|guarded by| RLS

    CollectorCron --> BrowserSession
    BrowserSession --> Procs
    Procs --> Tables
```

---

## 3. Core Component Architecture

### Frontend Subsystems
1. **Router & Kid Scoping (`app.js`)**:
   - Parses `location.pathname` (`/`, `/sophia`, `/olivia`).
   - Dynamically loads and filters the 21-day agenda horizon.
   - Manages CSS custom properties (`--accent`, `--accent-soft`) mapped to kid identity slugs.
2. **Add-to-Home-Screen Engine (`a2hs.js`)**:
   - Manages standalone PWA lifecycle across platforms (iOS Safari Share Sheet, Chrome/Edge `beforeinstallprompt`, macOS Safari 17+ Add to Dock).
   - Manages a 60-day snooze and suppresses banner once installed.
3. **Conversational Assistant (`ask/ask.js`)**:
   - Manages conversational thread and ephemeral turn state.
   - Intercepts client-side slash commands (`/clear`, `/new`, `/forget`, `/help`).
   - Communicates with the edge function passing device access token (`x-ask-token`).
4. **Document Registry (`documents/documents.js`)**:
   - Surfaces all scraped portal documents, extraction states, and target audiences.
   - Filters out-of-scope materials (Upper School, Grade 7+) by default.

### Database Subsystems
1. **Deduplication & Ingestion Triad**:
   - `raw_items`: Stores raw stream posts. Enforces uniqueness on `(kid_id, content_hash)`.
   - `upsert_raw_item()`: Calculates content hash, detects updates, archives historical revisions to `raw_item_versions`.
2. **Event Extraction & Materiality Detection**:
   - `events`: Stores individual calendar entries identified by `raw_item_id:activity_key`.
   - `upsert_event()`: Compares new attributes against existing events; if dates, times, or event types change, flags them as `material`, sets status to `pending`, and pushes to `v_review_queue`.
3. **Calendar & Day-Cycle Resolution**:
   - `day_cycle`: Holds the official school calendar mapping dates to Day 1–8 cycle numbers or closures (holidays, PD days).
   - `recurring_rules`: Expands timetable rules (e.g. Day 3 = Gym) into discrete events via `expand_recurring_rules()`.
4. **Semantic Chunker**:
   - `sync_chunks()`: Projects raw posts, extracted attachment texts, and school events into `doc_chunks` with `valid_from` and `valid_to` bounds, ready for vector embedding.

---

## 4. End-to-End Data Flow Sequence

The following diagram illustrates how a teacher posting in Google Classroom flows through the system to become an actionable card on a student's screen:

```mermaid
sequenceDiagram
    autonumber
    actor Teacher as Teacher
    participant GC as Google Classroom
    participant Scraper as Claude Collector (Chrome)
    participant DB as Postgres (Supabase)
    actor Parent as Parent (Henry)
    participant Client as Student Device (app.js)

    Teacher->>GC: Publishes post: "Math Test moved to Day 4"
    Note over Scraper: 6:00 AM / 4:00 PM / 8:00 PM cron triggers
    Scraper->>GC: Reads first page of stream & opens attachments
    GC-->>Scraper: Post HTML + attachments
    Scraper->>DB: CALL upsert_raw_item(kid_slug, source_key, title, body, ...)
    DB-->>Scraper: Status: 'changed' (content_hash modified)

    Note over Scraper: LLM extracts structured event JSON
    Scraper->>DB: CALL upsert_event(raw_item_id, activity_key, event_date, type, ...)
    DB->>DB: Material change detected (date changed!) -> status='pending'
    DB-->>Scraper: Status: 'updated', material: true
    Scraper->>DB: CALL reconcile_deletions() & sync_chunks()

    Note over Parent: Review step for material changes
    Parent->>DB: SELECT * FROM v_review_queue;
    Parent->>DB: UPDATE events SET status='published' WHERE id = ...

    Note over Client: Student opens app or visibilitychange triggers
    Client->>DB: GET /rest/v1/v_public_agenda?event_date=gte.today
    DB-->>Client: Returns published events
    Client->>Client: Merges localStorage 'done' ticks and renders cards
```

---

## 5. Trust Boundaries & Security Architecture

```mermaid
graph LR
    subgraph UntrustedZone["Public Web (Untrusted)"]
        AnonBrowser["Anonymous Visitor / Student"]
    end

    subgraph ReadSurface["Public Read Surface (Enforced by RLS)"]
        PublicViews["Public Views (Owner Rights)<br/>v_public_agenda<br/>v_public_kids<br/>v_public_status"]
    end

    subgraph PrivateZone["Private / Admin Zone (Protected)"]
        BaseDB["PostgreSQL Base Tables<br/>(RLS Denied to anon)"]
        EdgeAuth["Edge Function (/ask)<br/>Header: x-ask-token"]
        CollectorCreds["Claude Scraper<br/>(Service Role / DB Direct)"]
    end

    AnonBrowser -->|Read Only / Anon Key| PublicViews
    AnonBrowser -.->|Denied direct access| BaseDB
    PublicViews --> BaseDB
    EdgeAuth -->|Access Token Check| BaseDB
    CollectorCreds -->|Bypasses RLS| BaseDB
```

### Security Measures:
1. **Row Level Security (RLS) Denial**: All base tables (`kids`, `classes`, `raw_items`, `events`, `collection_runs`, etc.) have RLS enabled with zero anon policies. Direct table queries by the anonymous key yield zero rows.
2. **Restricted Public Projections**: Public views omit sensitive fields:
   - `kids.view_token` is never exposed.
   - `google_email`, student IDs, and private addresses are excluded.
   - Only `status = 'published'` and non-superseded events within `[-7, +120]` days are served.
3. **Isolated AI Query Endpoint (`/ask`)**:
   - The parent QA tool is gated behind an access token (`x-ask-token`) stored only in the parent device's `localStorage`.
   - The edge function validates this token before querying the database or issuing LLM requests.
4. **Prompt Injection Mitigation**:
   - Teacher posts and portal text are treated as untrusted user data.
   - Context is injected into LLM prompts wrapped strictly in `<context>...</context>` boundaries with explicit system instructions to ignore prompt overrides inside context.

---

## 6. Hosting & Deployment Topology

- **Domain**: `cal.studyflix.vip` pointing via CNAME to `candoit3721.github.io`.
- **Hosting**: GitHub Pages (served directly from the `main` branch root).
- **Zero-Build Architecture**: No Node.js build step, no Webpack/Vite bundle, and no package manager dependencies.
- **Cache Invalidation**: Automatic asset versioning handled by `.githooks/pre-commit`, hashing staged CSS/JS files and updating `?v=<hash>` query strings across all HTML entrypoints.
