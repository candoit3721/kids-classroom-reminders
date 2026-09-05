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

/* is-empty centres the composer; the first answer swaps to the
   conversation layout with the composer pinned at the bottom. */
function setEmpty(on){
  $("#askui").classList.toggle("is-empty", on);
  document.body.classList.toggle("chatting", !on);
  $("#newthread").hidden = on;
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
  $("#out").innerHTML = "";
  setEmpty(true);
  autogrow();
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

/* Minimal, safe rendering: headings, paragraphs, bullets, numbered
   lists, **bold**. Runs line by line rather than block by block, because
   the model routinely puts a heading and its bullets in one block.
   Everything is escaped first — no raw HTML from the model. */
const inline = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/\(my suggestion\)/gi, '<em class="sugg">(my suggestion)</em>');

function render(text){
  const out = [];
  let list = [], listTag = "ul";
  const flush = () => {
    if (list.length) out.push(`<${listTag}>${list.join("")}</${listTag}>`);
    list = [];
  };
  for (const raw of String(text ?? "").split("\n")){
    const l = raw.trim();
    if (!l){ flush(); continue; }

    const bullet = l.match(/^[-*+]\s+(.*)$/);
    if (bullet){
      if (listTag !== "ul"){ flush(); listTag = "ul"; }
      list.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = l.match(/^\d{1,2}[.)]\s+(.*)$/);
    if (numbered){
      if (listTag !== "ol"){ flush(); listTag = "ol"; }
      list.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    flush(); listTag = "ul";
    const heading = l.match(/^#{1,4}\s+(.*)$/);
    if (heading){ out.push(`<h3>${inline(heading[1])}</h3>`); continue; }
    // a short bold-only line reads as a heading too
    const boldOnly = l.match(/^\*\*(.+)\*\*:?$/);
    if (boldOnly && boldOnly[1].length < 40){ out.push(`<h3>${inline(boldOnly[1])}</h3>`); continue; }
    out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return out.join("");
}

function turnEl(question, res){
  const el = document.createElement("div");
  el.className = "turn";

  const srcs = (res.sources || []).filter(s => s.url)
    .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`)
    .join("");

  /* The count and the window are both optional — say nothing rather than
     "undefined notes consulted" when the function doesn't report them. */
  const n = Number(res.retrieved);
  const hasCount = res.retrieved != null && Number.isFinite(n) && n >= 0;
  const metaBits = [];
  if (res.window?.label) metaBits.push(esc(res.window.label));
  if (hasCount) metaBits.push(`${n} note${n === 1 ? "" : "s"} consulted`);
  const meta = metaBits.length ? `<p class="meta">${metaBits.join(" · ")}</p>` : "";

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
      ${meta}
      ${fus}
    </div>`;
  return el;
}

async function submit(question){
  const token = store.get();
  if (!question || !token) return;

  setEmpty(false);
  $("#go").disabled = true;
  $("#out").innerHTML =
    `<div class="thinking" role="status" aria-label="Looking through what we know">` +
    `<span></span><span></span><span></span></div>`;
  $("#out").scrollIntoView({ behavior: "smooth", block: "end" });

  try {
    const res = await call(question, token);
    $("#out").innerHTML = "";
    const el = turnEl(question, res);
    $("#thread").appendChild(el);
    history.push({ q: question, a: res.answer });
    if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if (err.message === "unauthorized"){ store.clear(); location.reload(); return; }
    $("#out").innerHTML =
      `<div class="answer err"><p>Couldn't answer that: ${esc(err.message)}</p></div>`;
  } finally {
    $("#go").disabled = false;
  }
}

function autogrow(){
  const t = $("#q");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 144) + "px";
}
$("#q").addEventListener("input", autogrow);

$("#askform").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  $("#q").value = "";
  autogrow();
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
