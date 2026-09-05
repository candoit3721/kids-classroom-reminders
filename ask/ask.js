/* ============================================================
   Ask — semantic Q&A over the family knowledge base.

   The page holds no secrets of its own. The Supabase anon key is
   public by design (RLS denies everything); the real gate is the
   access key, which is typed once and kept in localStorage on this
   device only. It is sent as x-ask-token and checked by the Edge
   Function, which is where the model keys actually live.
   ============================================================ */
const SUPABASE_URL = "https://eusazkbcvscjxwpmddtp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1c2F6a2JjdnNjanh3cG1kZHRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NzA4OTksImV4cCI6MjEwNDE0Njg5OX0.k7NexhNwyATa5-51t5APbjnJ61vex5ni0JvYLm4i77w";
const ASK_URL = `${SUPABASE_URL}/functions/v1/ask`;
const KEY_STORE = "askToken";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

const store = {
  get(){ try { return localStorage.getItem(KEY_STORE) } catch { return null } },
  set(v){ try { localStorage.setItem(KEY_STORE, v) } catch {} },
  clear(){ try { localStorage.removeItem(KEY_STORE) } catch {} }
};

let kidScope = "";

/* ---------------------------------------------------------- gate */
function showAsk(){
  $("#unlock").hidden = true;
  $("#askui").hidden = false;
  $("#forget").hidden = false;
  $("#q").focus();
}

if (store.get()) showAsk(); else $("#unlock").hidden = false;

$("#unlock").addEventListener("submit", async e => {
  e.preventDefault();
  const token = $("#tokenInput").value.trim();
  if (!token) return;
  $("#unlockErr").hidden = true;
  // Validate by asking something trivial; a bad key comes back 401.
  const res = await call("ping", token).catch(() => null);
  if (res === null){ $("#unlockErr").hidden = false; return; }
  store.set(token);
  $("#tokenInput").value = "";
  showAsk();
});

$("#forget").addEventListener("click", () => {
  store.clear();
  location.reload();
});

/* ------------------------------------------------------ kid scope */
$("#kidscope").addEventListener("click", e => {
  const b = e.target.closest("button[data-kid]");
  if (!b) return;
  kidScope = b.dataset.kid;
  [...$("#kidscope").children].forEach(x => x.classList.toggle("on", x === b));
});

/* ----------------------------------------------------------- ask */
async function call(question, token){
  const r = await fetch(ASK_URL, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "x-ask-token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ question, kid: kidScope || null })
  });
  if (r.status === 401) throw new Error("unauthorized");
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

/* Minimal, safe rendering: paragraphs, bullets, **bold**. No raw HTML. */
function render(text){
  const blocks = String(text).split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split("\n").filter(l => l.trim());
    const bullets = lines.filter(l => /^\s*[-*]\s+/.test(l));
    const bold = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (bullets.length === lines.length && lines.length){
      return `<ul>${lines.map(l => `<li>${bold(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${bold(b)}</p>`;
  }).join("");
}

$("#askform").addEventListener("submit", async e => {
  e.preventDefault();
  const question = $("#q").value.trim();
  const token = store.get();
  if (!question || !token) return;

  $("#go").disabled = true;
  $("#out").innerHTML = `<p class="thinking">Looking through what we know</p>`;

  try {
    const res = await call(question, token);
    const srcs = (res.sources || [])
      .filter(s => s.url)
      .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`)
      .join("");
    $("#out").innerHTML = `
      <div class="answer">
        ${res.person ? `<span class="who">${esc(res.person)}</span>` : ""}
        ${render(res.answer)}
        ${srcs ? `<p class="srcs">Sources: ${srcs}</p>` : ""}
        <p class="meta">${res.retrieved} note${res.retrieved === 1 ? "" : "s"} consulted</p>
      </div>`;
  } catch (err) {
    if (err.message === "unauthorized"){
      store.clear();
      location.reload();
      return;
    }
    $("#out").innerHTML =
      `<div class="answer err"><p>Couldn't answer that: ${esc(err.message)}</p></div>`;
  } finally {
    $("#go").disabled = false;
  }
});
