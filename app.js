/* ============================================================
   School Day - reads Supabase public views. No build step.
   Which kid is shown comes from the URL path:
     /            → both
     /sophia/     → Sophia
     /olivia/     → Olivia
   ============================================================ */
const SUPABASE_URL = "https://eusazkbcvscjxwpmddtp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1c2F6a2JjdnNjanh3cG1kZHRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NzA4OTksImV4cCI6MjEwNDE0Njg5OX0.k7NexhNwyATa5-51t5APbjnJ61vex5ni0JvYLm4i77w";
const TZ = "America/Toronto";
const HORIZON_DAYS = 21;

const $ = s => document.querySelector(s);
const api = async (view, qs="") => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${view}?${qs}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) throw new Error(`${view}: ${r.status}`);
  return r.json();
};

/* dates as YYYY-MM-DD strings in the school's timezone */
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
const todayISO = () => fmt.format(new Date());
const addDays = (iso, n) => {
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m-1, d + n)).toISOString().slice(0,10);
};
const asUTC = iso => { const [y,m,d] = iso.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)); };
const pretty   = iso => asUTC(iso).toLocaleDateString("en-CA", { timeZone:"UTC", weekday:"long", month:"long", day:"numeric" });
const dayName  = iso => asUTC(iso).toLocaleDateString("en-CA", { timeZone:"UTC", weekday:"long" });
const dayShort = iso => asUTC(iso).toLocaleDateString("en-CA", { timeZone:"UTC", month:"short", day:"numeric" });
const time12 = t => {
  if (!t) return null;
  let [h,mi] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return mi ? `${h}:${String(mi).padStart(2,"0")}${ap}` : `${h}${ap}`;
};
/* PostgREST returns "2026-09-05 10:00:00+00" - not parseable by Date() as-is */
const ts = v => {
  if (!v) return null;
  const d = new Date(String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return isNaN(d) ? null : d;
};
const clock = d => d.toLocaleTimeString("en-US", { timeZone:TZ, hour:"numeric", minute:"2-digit" })
                    .toLowerCase().replace(/\s/g, "");
const ago = d => {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 2)    return "just now";
  if (mins < 60)   return `${mins} min ago`;
  const h = Math.round(mins/60);
  if (h < 24)      return h === 1 ? "an hour ago" : `${h} hours ago`;
  const dd = Math.round(h/24);
  return dd === 1 ? "yesterday" : `${dd} days ago`;
};
const soon = d => {
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins < 60) return `in ${Math.max(1,mins)} min`;
  const h = Math.round(mins/60);
  return h < 24 ? `in ${h} h` : clock(d);
};

const ICONS = { due:"📌", bring:"🎒", test:"📝", tryout:"⭐", practice:"🏃", form:"📋",
                gym:"👟", library:"📚", french:"🇫🇷", trip:"🚌", info:"ℹ️",
                closure:"🏡", break:"🏡", pa_day:"🏡", spirit:"🎨", photo:"📸",
                concert:"🎵", athletics:"🏅", conference:"👋", report_card:"📄" };

/* kid comes from the path, not a control */
function kidFromPath(){
  const seg = location.pathname.split("/").filter(Boolean).pop();
  return (seg || "").toLowerCase();
}

const state = { kid:"both", locked:false, school:true, kids:[], events:[], school_events:[], days:{}, status:null, runs:[], open:new Set() };
const key = e => `done:${e.kid_slug||"school"}:${e.event_date}:${e.kid_title}`;
const isDone  = e => { try { return localStorage.getItem(key(e)) === "1"; } catch { return false; } };
const setDone = (e,v) => { try { v ? localStorage.setItem(key(e),"1") : localStorage.removeItem(key(e)); } catch {} };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

async function load(){
  const from = addDays(todayISO(), -1), to = addDays(todayISO(), HORIZON_DAYS);
  const [kids, ev, se, dc, st, runs] = await Promise.all([
    api("v_public_kids", "select=*"),
    api("v_public_agenda", `select=*&event_date=gte.${from}&event_date=lte.${to}&order=event_date,start_time.nullsfirst`),
    api("v_public_school_events", "select=*&order=event_date"),
    api("v_public_day_cycle", `select=*&school_date=gte.${from}&school_date=lte.${to}`),
    api("v_public_status", "select=*").catch(() => []),
    api("v_public_sync_log", "select=*&order=at.desc&limit=18").catch(() => [])
  ]);
  state.kids = kids.sort((a,b) => Number(b.grade) - Number(a.grade));
  state.events = ev;
  state.school_events = se;
  state.days = Object.fromEntries(dc.map(d => [d.school_date, d]));
  state.status = st[0] || null;
  state.runs = runs;

  const want = kidFromPath();
  if (state.kids.some(k => k.slug === want)){
    state.kid = want; state.locked = true;          // /sophia or /olivia - fixed
  } else {
    state.locked = false;
    let saved = null;
    try { saved = localStorage.getItem("filter"); } catch {}
    state.kid = state.kids.some(k => k.slug === saved) ? saved : "both";
  }

  renderFilter(); render(); renderFresh(); renderLog();
}

/* Kid filter: shown only on "/" - the per-kid URLs are already decided. */
function renderFilter(){
  const host = document.querySelector("#kidfilter");
  if (!host) return;
  host.innerHTML = "";
  document.documentElement.dataset.kid = state.kid;
  if (state.locked){ host.hidden = true; return; }
  host.hidden = false;

  const seg = document.createElement("div");
  seg.className = "seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Whose day to show");
  for (const o of [{v:"both", l:"All"}, ...state.kids.map(k => ({v:k.slug, l:k.display_name}))]){
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = o.l;
    b.setAttribute("aria-pressed", String(state.kid === o.v));
    b.onclick = () => {
      state.kid = o.v;
      try { localStorage.setItem("filter", o.v); } catch {}
      renderFilter(); render();
    };
    seg.appendChild(b);
  }
  host.appendChild(seg);
}

function schoolCards(from, to){
  const out = [];
  for (const s of state.school_events){
    let d = s.event_date; const end = s.end_date || s.event_date;
    while (d <= end){
      if (d >= from && d <= to) out.push({
        event_date:d, kid_title:s.title, icon:ICONS[s.category] || "🏫", type:s.category,
        parent_detail:s.detail, start_time:null, kid_slug:null,
        class_name:"School calendar", _school:true });
      d = addDays(d, 1);
    }
  }
  return out;
}

function visible(from, to){
  let ev = state.events.filter(e => e.event_date >= from && e.event_date <= to);
  if (state.kid !== "both") ev = ev.filter(e => e.kid_slug === state.kid);
  if (state.school) ev = ev.concat(schoolCards(from, to));
  const rank = { closure:0, break:0, pa_day:0 };
  return ev.sort((a,b) =>
    a.event_date.localeCompare(b.event_date) ||
    (rank[a.type] ?? 9) - (rank[b.type] ?? 9) ||
    (a.start_time || "zz").localeCompare(b.start_time || "zz") ||
    a.kid_title.localeCompare(b.kid_title));
}

function card(e){
  const el = document.createElement("div");
  el.className = "card" + (e._school ? " school" : "") + (isDone(e) ? " done" : "");
  el.dataset.open = state.open.has(key(e)) ? "1" : "0";
  const kid = state.kids.find(k => k.slug === e.kid_slug);
  const bits = [];
  if (e.start_time) bits.push(time12(e.start_time) + (e.end_time ? `–${time12(e.end_time)}` : ""));
  if (state.kid === "both" && kid)
    bits.push(`<span class="who" data-theme="${esc(kid.theme || "")}">${esc(kid.display_name)}</span>`);
  if (e._school) bits.push("School");
  el.innerHTML = `
    <div class="emoji">${e.icon || ICONS[e.type] || "•"}</div>
    <div>
      <p class="title">${esc(e.kid_title)}</p>
      ${bits.length ? `<p class="meta">${bits.join("<span>·</span>")}</p>` : ""}
    </div>
    <button class="tick" aria-label="Mark done">✓</button>
    <div class="detail">
      ${e.parent_detail ? `<p style="margin:0 0 .5rem">${esc(e.parent_detail)}</p>` : ""}
      ${e.class_name ? `<p style="margin:0 0 .5rem">${esc(e.class_name)}</p>` : ""}
      ${e.source_url ? `<a href="${esc(e.source_url)}" target="_blank" rel="noopener">See the original post →</a>` : ""}
    </div>`;
  el.querySelector(".tick").onclick = ev => {
    ev.stopPropagation(); const now = !isDone(e); setDone(e, now); el.classList.toggle("done", now);
  };
  el.onclick = () => {
    const k = key(e), open = el.dataset.open === "1";
    el.dataset.open = open ? "0" : "1";
    open ? state.open.delete(k) : state.open.add(k);
  };
  return el;
}

function dayHeading(iso){
  const info = state.days[iso], off = info && info.day_number === null;
  const h = document.createElement("div");
  h.className = "daygroup" + (off ? " off" : "");
  h.innerHTML = `<span class="d">${dayName(iso)}</span><span class="n">${dayShort(iso)}</span>` +
    (info && info.day_number ? `<span class="pill">Day ${info.day_number}</span>`
     : off ? `<span class="pill">No school</span>` : "");
  return h;
}

function section(title, items, mode, emptyMsg){
  const s = document.createElement("section");
  s.innerHTML = `<h2>${title}${items.length ? ` <span class="count">${items.length}</span>` : ""}</h2>`;
  if (!items.length){
    if (!emptyMsg) return null;
    const d = document.createElement("div"); d.className = "empty"; d.innerHTML = emptyMsg;
    s.appendChild(d); return s;
  }
  if (mode === "grouped"){
    let cur = null;
    for (const e of items){
      if (e.event_date !== cur){ cur = e.event_date; s.appendChild(dayHeading(cur)); }
      s.appendChild(card(e));
    }
  } else items.forEach(e => s.appendChild(card(e)));
  return s;
}

function render(){
  const t = todayISO(), tom = addDays(t,1), end = addDays(t, HORIZON_DAYS);
  const c = $("#content"); c.innerHTML = "";

  const me = state.kids.find(k => k.slug === state.kid);
  $("#hello").textContent = me ? `Hi ${me.display_name}` : "Hey you two";
  document.title = me ? `${me.display_name} · School Day` : "School Day";

  const info = state.days[t];
  $("#todayline").innerHTML = pretty(t) +
    (info?.day_number ? `<span class="daypill">Day ${info.day_number}</span>` : "");

  if (info && info.day_number === null){
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = "🎉 No school today" + (info.note ? " - " + info.note.replace(/\s*\(school closed\)/i,"") : "");
    c.appendChild(n);
  }

  [ section("Today", visible(t,t), "flat", `<span class="big">✨</span>Nothing on today. Enjoy it!`),
    section("Tomorrow", visible(tom,tom), "flat", `<span class="big">😌</span>Nothing tomorrow either.`),
    section("Coming up", visible(addDays(t,2), end), "grouped", null)
  ].filter(Boolean).forEach(s => c.appendChild(s));

  if (!c.children.length) c.innerHTML = `<div class="empty"><span class="big">🌱</span>Nothing scheduled yet.</div>`;
}

/* Freshness: one quiet line, always visible. */
function renderFresh(){
  const el = $("#fresh"); if (!el) return;
  const s = state.status;
  const last = ts(s?.last_success_at), next = ts(s?.next_scheduled_at);
  const failed = s?.last_run_status === "error";

  if (!last){
    el.dataset.state = failed ? "late" : "unknown";
    el.querySelector(".txt").textContent = failed ? "Last sync failed" : "Waiting for first sync";
    el.querySelector(".more").textContent = next ? ` · next ${soon(next)}` : "";
    return;
  }
  el.dataset.state = s.on_schedule ? "ok" : "late";
  el.querySelector(".txt").textContent = `Synced ${ago(last)}`;
  const bits = [`at ${clock(last)}`];
  if (next) bits.push(`next ${soon(next)}`);
  if (!s.on_schedule) bits.push(failed ? "last sync failed" : "last sync was missed");
  el.querySelector(".more").textContent = " · " + bits.join(" · ");
}

/* Sync log: scheduled slot vs what actually ran. Reference only - folded away
   behind the freshness line, muted, never competing with the kids' cards. */
const OUTCOME = {
  error:     () => "failed",
  running:   () => "running…",
  missed:    () => "didn’t run",
  due:       () => "no result yet",
  scheduled: () => "scheduled",
  ok: r => {
    const bits = [];
    if (r.events_new)     bits.push(`${r.events_new} new`);
    if (r.events_updated) bits.push(`${r.events_updated} updated`);
    return bits.length ? bits.join(", ") : "nothing new";
  }
};

/* "Today" / "Yesterday" / "Wed, Sep 3" for a Toronto-local instant */
function dayLabel(d){
  const iso = fmt.format(d), t = todayISO();
  if (iso === t)            return "Today";
  if (iso === addDays(t,1)) return "Tomorrow";
  if (iso === addDays(t,-1))return "Yesterday";
  return asUTC(iso).toLocaleDateString("en-CA", { timeZone:"UTC", weekday:"short", month:"short", day:"numeric" });
}

const LOG_HISTORY = 12;   // enough to see a pattern, not a wall of dots

function renderLog(){
  const host = $("#synclog"); if (!host) return;
  const rows = (state.runs || []).filter(r => ts(r.at));
  if (!rows.length){
    host.innerHTML = `<p class="logempty">No sync history yet.</p>`;
    return;
  }
  /* the next scheduled slot, then history newest-first */
  const now = Date.now();
  const ahead = rows.filter(r => ts(r.at) > now).sort((a,b) => ts(a.at) - ts(b.at));
  const past  = rows.filter(r => ts(r.at) <= now)
                    .sort((a,b) => ts(b.at) - ts(a.at)).slice(0, LOG_HISTORY);

  const out = [`<p class="loghead">Sync log<span>Google Classroom → this page</span></p>`, `<ol>`];
  let day = null;
  for (const r of ahead.slice(0,1).concat(past)){
    const at = ts(r.at), ran = ts(r.started_at), slot = ts(r.slot_at);
    const upcoming = at.getTime() > now;
    const d = upcoming ? "Next" : dayLabel(at);
    if (d !== day){ day = d; out.push(`<li class="dayhead">${esc(d)}</li>`); }

    /* the actual execution is the headline time; the slot it belongs to is the aside */
    const drifted = ran && slot && Math.abs(ran - slot) > 10*60000;
    const when = ran || slot;
    const aside = [];
    if (upcoming && dayLabel(at) !== "Today") aside.push(esc(dayLabel(at).toLowerCase()));
    if (r.label) aside.push(esc(r.label));
    if (drifted) aside.push(`slot ${clock(slot)}`);
    if (!slot && ran) aside.push("unscheduled");

    out.push(
      `<li data-status="${esc(r.status)}">
         <span class="pip"></span>
         <span class="t">${when ? clock(when) : "-"}</span>
         <span class="s">${(Object.hasOwn(OUTCOME, r.status) ? OUTCOME[r.status] : OUTCOME.scheduled)(r)}${
           aside.length ? `<em>${aside.join(" · ")}</em>` : ""}</span>
       </li>` +
      (r.error ? `<li class="logerr">${esc(r.error)}</li>` : ""));
  }
  out.push(`</ol>`, `<p class="logfoot">Scheduled 3× a day · times are Toronto</p>`);
  host.innerHTML = out.join("");
}

/* wiring */
$("#showSchool").onchange = e => {
  state.school = e.target.checked;
  $("#schoolToggle").dataset.on = state.school ? "1" : "0";
  try { localStorage.setItem("school", state.school ? "1" : "0"); } catch {}
  render();
};
$("#fresh").onclick = () => {
  const el = $("#fresh"), open = el.dataset.open === "1";
  el.dataset.open = open ? "0" : "1";
  el.setAttribute("aria-expanded", String(!open));
  const log = $("#synclog"); if (log) log.hidden = open;
};
/* Ask is parent-only. Reveal the way in only where its key already lives, so
   the kids' pages stay clean; the key itself is still what guards the page. */
try {
  if (localStorage.getItem("askToken")) $("#asklink").hidden = false;
} catch {}
try {
  if (localStorage.getItem("school") === "0"){
    state.school = false; $("#showSchool").checked = false; $("#schoolToggle").dataset.on = "0";
  }
} catch {}

const fail = err => {
  $("#content").innerHTML =
    `<div class="empty"><span class="big">📡</span>Couldn't load right now.<br>
     <small style="opacity:.7">${esc(err.message)}</small></div>`;
};
load().catch(fail);
setInterval(() => load().catch(()=>{}), 15*60*1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(()=>{}); });
