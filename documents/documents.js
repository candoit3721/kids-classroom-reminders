/* ============================================================
   Documents — a human-readable index of everything the portal
   sweep has registered, extracted and embedded. Reads two public,
   metadata-only views; no document text is exposed here.
   ============================================================ */
const SUPABASE_URL = "https://eusazkbcvscjxwpmddtp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1c2F6a2JjdnNjanh3cG1kZHRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NzA4OTksImV4cCI6MjEwNDE0Njg5OX0.k7NexhNwyATa5-51t5APbjnJ61vex5ni0JvYLm4i77w";
const TZ = "America/Toronto";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const api = async (view, qs="") => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${view}?${qs}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) throw new Error(`${view}: ${r.status}`);
  return r.json();
};
/* PostgREST timestamps ("2026-09-05 10:00:00+00") are not Date()-parseable as-is */
const ts = v => { if (!v) return null;
  const d = new Date(String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")); return isNaN(d) ? null : d; };
const when = v => { const d = ts(v); return d ? d.toLocaleString("en-CA", { timeZone: TZ, month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "—"; };

const KIND = { cdn:"file", gdoc:"Google Doc", gsheet:"Google Sheet", gslides:"Google Slides", gdrive:"Drive file", web:"web page" };
const APPLIES = {
  sophia: ["sophia", "Sophia only"], olivia: ["olivia", "Olivia only"],
  both: ["both", "Both girls"], school_wide: ["wide", "School-wide"], out_of_scope: ["oos", "Out of scope"]
};

let docs = [], runs = [], scope = "", showOos = false;

function visible(d){
  if (d.is_duplicate_placement) return false;             // same file, second placement
  if (d.applies_to === "out_of_scope") return showOos;
  if (!scope) return true;
  return d.applies_to === scope || d.applies_to === "both" || d.applies_to === "school_wide";
}

function card(d){
  const [cls, label] = APPLIES[d.applies_to] || ["wide", d.applies_to];
  const ok = d.extract_status === "ok";
  const src = d.file_url || d.portal_url;
  return `
    <article class="doc${d.applies_to === "out_of_scope" ? " oos" : ""}">
      <h3 class="t">${src ? `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)}</h3>
      <p class="s">${esc(d.section && d.section !== d.title ? d.section : "")}</p>
      <div class="badges">
        <span class="badge ${cls}">${label}</span>
        ${ok ? "" : `<span class="badge warn">${esc(d.extract_status)}</span>`}
      </div>
      <p class="meta">
        <span><span class="k">type</span> ${esc(KIND[d.source_type] || d.source_type)}${d.file_ext && d.source_type === "cdn" ? " · " + esc(d.file_ext) : ""}</span>
        ${d.edition_label ? `<span><span class="k">edition</span> ${esc(d.edition_label)}</span>` : ""}
        ${ok ? `<span><span class="k">indexed</span> ${d.chunks} chunk${d.chunks === 1 ? "" : "s"} · ${Number(d.chars || 0).toLocaleString()} chars</span>` : ""}
        <span><span class="k">checked</span> ${when(d.last_checked_at || d.last_seen_at)}</span>
        ${!ok && d.extract_note ? `<span class="note">${esc(d.extract_note)}</span>` : ""}
      </p>
    </article>`;
}

function render(){
  const c = $("#content");
  const shown = docs.filter(visible);
  const groups = new Map();
  for (const d of shown){ const k = d.container || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  c.innerHTML = [...groups.entries()].map(([name, list]) => `
    <section class="group">
      <h2>${esc(name)} <span class="n">${list.length}</span></h2>
      <div class="docs">${list.map(card).join("")}</div>
    </section>`).join("") || `<div class="empty"><span class="big">📄</span>Nothing to show.</div>`;

  const primary = docs.filter(d => !d.is_duplicate_placement);
  const inScope = primary.filter(d => d.applies_to !== "out_of_scope");
  const indexed = inScope.filter(d => d.extract_status === "ok");
  const chunks = indexed.reduce((n, d) => n + Number(d.chunks || 0), 0);
  const last = runs.find(r => r.status === "ok");
  $("#summary").innerHTML =
    `<strong>${indexed.length}</strong> of ${inScope.length} in-scope documents indexed · <strong>${chunks}</strong> chunks` +
    ` · ${primary.length - inScope.length} out of scope` +
    (last ? ` · last sweep ${when(last.finished_at)}` : "");
}

$("#scope").addEventListener("click", e => {
  const b = e.target.closest("button[data-scope]"); if (!b) return;
  scope = b.dataset.scope;
  [...$("#scope").children].forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
  render();
});
$("#showOos").addEventListener("change", e => {
  showOos = e.target.checked; $("#oosToggle").dataset.on = showOos ? "1" : "0"; render();
});

(async () => {
  try {
    [docs, runs] = await Promise.all([
      api("v_public_portal_docs", "select=*"),
      api("v_public_portal_runs", "select=*")
    ]);
    render();
  } catch (err) {
    $("#content").innerHTML = `<div class="empty"><span class="big">⚠️</span>Couldn't load the document list.<br><small>${esc(err.message)}</small></div>`;
    $("#summary").textContent = "";
  }
})();
