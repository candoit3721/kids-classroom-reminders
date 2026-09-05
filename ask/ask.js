/* ============================================================
   Ask — conversational semantic search over the family corpus.

   The page holds no secrets of its own. The Supabase anon key is
   public by design (RLS denies everything); the real gate is the
   access key, typed once and kept in localStorage on this device.
   It goes up as x-ask-token and is checked by the Edge Function,
   which is where the model keys actually live.

   Conversation state lives in memory only — reloading starts fresh.
   ============================================================ */
const SUPABASE_URL = "https://eusazkbcvscjxwpmddtp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1c2F6a2JjdnNjanh3cG1kZHRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NzA4OTksImV4cCI6MjEwNDE0Njg5OX0.k7NexhNwyATa5-51t5APbjnJ61vex5ni0JvYLm4i77w";
const ASK_URL = `${SUPABASE_URL}/functions/v1/ask`;
const KEY_STORE = "askToken";
const MAX_TURNS = 4;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

const store = {
  get(){ try { return localStorage.getItem(KEY_STORE) } catch { return null } },
  set(v){ try { localStorage.setItem(KEY_STORE, v) } catch {} },
  clear(){ try { localStorage.removeItem(KEY_STORE) } catch {} }
};

let kidScope = "";
let history = [];          // [{q, a}] — the last few turns, sent up for context

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
  const ok = await call("ping", token).then(() => true).catch(() => false);
  if (!ok){ $("#unlockErr").hidden = false; return; }
  store.set(token);
  $("#tokenInput").value = "";
  showAsk();
});

$("#forget").addEventListener("click", () => { store.clear(); location.reload(); });
$("#newthread").addEventListener("click", () => {
  history = [];
  $("#thread").innerHTML = "";
  $("#newthread").hidden = true;
  $("#q").focus();
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
    body: JSON.stringify({
      question,
      kid: kidScope || null,
      history: history.slice(-MAX_TURNS)
    })
  });
  if (r.status === 401) throw new Error("unauthorized");
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

/* Minimal, safe rendering: headings, paragraphs, bullets, **bold**.
   Everything is escaped first — no raw HTML from the model. */
function render(text){
  return String(text).split(/\n{2,}/).map(block => {
    const lines = block.split("\n").filter(l => l.trim());
    if (!lines.length) return "";
    const inline = s => esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\(my suggestion\)/gi, '<em class="sugg">(my suggestion)</em>');
    if (lines.every(l => /^\s*#{1,4}\s+/.test(l)))
      return lines.map(l => `<h3>${inline(l.replace(/^\s*#{1,4}\s+/, ""))}</h3>`).join("");
    if (lines.every(l => /^\s*[-*]\s+/.test(l)))
      return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return lines.map(l => /^\s*#{1,4}\s+/.test(l)
      ? `<h3>${inline(l.replace(/^\s*#{1,4}\s+/, ""))}</h3>`
      : `<p>${inline(l)}</p>`).join("");
  }).join("");
}

function turnEl(question, res){
  const el = document.createElement("div");
  el.className = "turn";

  const srcs = (res.sources || []).filter(s => s.url)
    .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`)
    .join("");

  const fus = (res.followups || []).length
    ? `<div class="followups"><p class="fu-label">Ask next</p>${
        res.followups.map(f => `<button type="button" data-q="${esc(f)}">${esc(f)}</button>`).join("")
      }</div>`
    : "";

  el.innerHTML = `
    <div class="qbubble">${esc(question)}</div>
    <div class="answer">
      ${res.person ? `<span class="who">${esc(res.person)}</span>` : ""}
      ${render(res.answer)}
      ${srcs ? `<p class="srcs"><span class="lbl">Sources</span>${srcs}</p>` : ""}
      <p class="meta">${res.window ? `${esc(res.window.label)} · ` : ""}${res.retrieved} note${res.retrieved === 1 ? "" : "s"} consulted</p>
      ${fus}
    </div>`;
  return el;
}

async function submit(question){
  const token = store.get();
  if (!question || !token) return;

  $("#go").disabled = true;
  $("#out").innerHTML = `<p class="thinking">Looking through what we know</p>`;

  try {
    const res = await call(question, token);
    $("#out").innerHTML = "";
    const el = turnEl(question, res);
    $("#thread").appendChild(el);
    $("#newthread").hidden = false;
    history.push({ q: question, a: res.answer });
    if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    if (err.message === "unauthorized"){ store.clear(); location.reload(); return; }
    $("#out").innerHTML =
      `<div class="answer err"><p>Couldn't answer that: ${esc(err.message)}</p></div>`;
  } finally {
    $("#go").disabled = false;
  }
}

$("#askform").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  $("#q").value = "";
  submit(q);
});

/* Enter sends, Shift+Enter makes a new line */
$("#q").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); $("#askform").requestSubmit(); }
});

/* follow-up chips and the example list both just ask the question */
document.addEventListener("click", e => {
  const chip = e.target.closest(".followups button[data-q]");
  if (chip){ submit(chip.dataset.q); return; }
  const ex = e.target.closest(".examples li");
  if (ex){ submit(ex.textContent.trim()); }
});
