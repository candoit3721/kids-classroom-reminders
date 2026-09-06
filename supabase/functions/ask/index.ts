// ask — hybrid, multi-turn Q&A over the whole family corpus.
//
// DATE PATH: "what do I need for next week?" — the window is resolved
// arithmetically and the agenda read from the database. Embeddings cannot
// resolve "next week" to a date range, or know that Day 2 is Art.
//
// SEMANTIC PATH: cosine search over doc_chunks (posts, attachment text,
// recurring rules, one-off events, school events, person facts), scoped to
// the same window when there is one.
//
// Follow-ups ("what about Olivia?") carry no dates or names of their own, so
// retrieval runs against the previous question joined to the current one
// while the model still answers only the current one.
//
// Retrieved text is written by teachers and other third parties. It is fenced
// as data; the model is told never to act on instructions inside it — but that
// rule is scoped to the fenced tags only, never to Henry's own question.
//
// Boys-only / girls-only content: the agenda and the event chunks are already
// filtered in the database against each kid's recorded gender. Posts are not
// (one post can list several teams), so the model is told who the kids are
// and to leave the other gender's activities out.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { todayISO, pretty, resolveWindow } from "./dates.ts";
import { SYSTEM } from "./prompt.ts";

const EMBED_MODEL = Deno.env.get("EMBEDDING_MODEL") ?? "text-embedding-3-small";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "gpt-4o-mini";
const TOP_K = 16;
const MAX_TURNS = 4;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-ask-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const askToken = Deno.env.get("ASK_TOKEN");
  if (!askToken) return json({ error: "ASK_TOKEN is not set" }, 500);
  if (req.headers.get("x-ask-token") !== askToken) return json({ error: "unauthorized" }, 401);

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) return json({ error: "OPENAI_API_KEY is not set" }, 500);

  let question = "", kidSlug: string | null = null;
  let history: Array<{ q: string; a: string }> = [];
  try {
    const b = await req.json();
    question = String(b.question ?? "").trim();
    kidSlug = b.kid ? String(b.kid).toLowerCase() : null;
    if (Array.isArray(b.history)) {
      history = b.history.slice(-MAX_TURNS).map((t: Record<string, unknown>) => ({
        q: String(t.q ?? "").slice(0, 1000),
        a: String(t.a ?? "").slice(0, 4000),
      })).filter((t: { q: string }) => t.q);
    }
  } catch { return json({ error: "body must be JSON" }, 400); }
  if (!question) return json({ error: "question is required" }, 400);
  if (question.length > 1000) return json({ error: "question too long" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = todayISO();

  const prev = history.length ? history[history.length - 1].q : "";
  const retrievalText = prev ? `${prev}\n${question}` : question;
  const win = resolveWindow(question, today) ?? (prev ? resolveWindow(prev, today) : null);

  /* -------------------------------------------------- 1. facets */
  const { data: people } = await db.rpc("resolve_person", { p_text: retrievalText });
  const person = people?.[0] ?? null;

  const { data: kidRows } = await db.from("kids").select("id,slug,display_name,gender");
  const kids = (kidRows ?? []) as Array<{ id: string; slug: string; display_name: string; gender: string }>;
  const kidId: string | null = kidSlug ? (kids.find((k) => k.slug === kidSlug)?.id ?? null) : null;

  // Who does boys-only / girls-only content apply to? Built from the data, so
  // a kid recorded as N/A drops out of the note and sees both kinds.
  const known = kids.filter((k) => k.gender === "M" || k.gender === "F");
  const genderNote = known.length
    ? `Note: ${known.map((k) => `${k.display_name} is a ${k.gender === "F" ? "girl" : "boy"}`).join("; ")}. ` +
      `Activities the school runs for ${[...new Set(known.map((k) => (k.gender === "F" ? "boys" : "girls")))].join(" or ")} only do not apply ` +
      `and should be left out unless the question asks about them directly. Co-ed activities apply.`
    : "";

  /* -------------------------------------------------- 2. date path */
  let agendaText = "";
  let agendaDays = 0;
  if (win) {
    const { data: rows } = await db.rpc("agenda_window", {
      p_from: win.from, p_to: win.to, p_kid_slug: kidSlug,
    });
    const byKid = new Map<string, string[]>();
    for (const r of rows ?? []) {
      const entries = (r.entries ?? []) as Array<Record<string, unknown>>;
      if (!entries.length) continue;
      const line = entries.map((e) => {
        const t = e.start_time ? ` ${String(e.start_time).slice(0, 5)}` : "";
        const d = e.detail ? ` — ${e.detail}` : "";
        return `    • ${e.title}${t}${d}`;
      }).join("\n");
      const head = `  ${pretty(r.school_date)}${r.day_number ? ` (Day ${r.day_number})` : ""}`;
      const key = r.kid_name ?? "School";
      if (!byKid.has(key)) byKid.set(key, []);
      byKid.get(key)!.push(`${head}\n${line}`);
      agendaDays++;
    }
    agendaText = [...byKid.entries()].map(([kid, days]) => `${kid}:\n${days.join("\n")}`).join("\n\n");
  }

  /* -------------------------------------------------- 3. semantic path */
  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: retrievalText }),
  });
  if (!embRes.ok) return json({ error: `embedding failed: ${embRes.status}` }, 502);
  const qvec = (await embRes.json()).data[0].embedding as number[];

  const { data: hits, error: sErr } = await db.rpc("search_chunks", {
    p_embedding: `[${qvec.join(",")}]`,
    p_person_id: person?.id ?? null,
    p_kid_id: kidId,
    p_kinds: null,
    p_limit: TOP_K,
    p_min_similarity: 0.12,
    p_from: win?.from ?? null,
    p_to: win?.to ?? null,
    p_undated: true,
  });
  if (sErr) return json({ error: `search: ${sErr.message}` }, 500);

  type Ctx = { label: string; title: string; text: string; url?: string | null; score?: number };
  const context: Ctx[] = (hits ?? []).map((h: Record<string, unknown>) => ({
    label: [h.kid_slug, h.kind].filter(Boolean).join("/") as string,
    title: (h.title as string) || (h.kind as string),
    text: h.content as string,
    url: h.source_url as string | null,
    score: h.score as number,
  }));

  if (!agendaText && !context.length) {
    return json({
      answer: "Nothing in the knowledge base matches that yet. If it should be there, the collector may not have seen the post — or the detail lives in an attachment that hasn't been read.",
      person: person?.display_name ?? null, window: win, followups: [], sources: [], retrieved: 0,
    });
  }

  /* -------------------------------------------------- 4. answer */
  const fenced = context.map((c, i) => `[${i + 1}] (${c.label})\n${c.text}`).join("\n\n");
  const parts = [`Today is ${pretty(today)} (${today}).`];
  if (win) parts.push(`The question is about ${win.label}: ${win.from} to ${win.to}.`);
  if (genderNote) parts.push(genderNote);
  if (agendaText) parts.push(`<agenda>\n${agendaText}\n</agenda>`);
  if (fenced) parts.push(`<context>\n${fenced}\n</context>`);
  parts.push(`Question: ${question}`);

  const messages: Array<{ role: string; content: string }> = [{ role: "system", content: SYSTEM }];
  for (const t of history) {
    messages.push({ role: "user", content: t.q });
    if (t.a) messages.push({ role: "assistant", content: JSON.stringify({ answer: t.a, followups: [] }) });
  }
  messages.push({ role: "user", content: parts.join("\n\n") });

  const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL, temperature: 0.3, messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!chatRes.ok) return json({ error: `chat failed: ${chatRes.status}` }, 502);

  const raw = (await chatRes.json()).choices[0].message.content as string;
  let answer = raw, followups: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.answer === "string") answer = parsed.answer;
    if (Array.isArray(parsed.followups)) {
      followups = parsed.followups
        .filter((f: unknown) => typeof f === "string" && f.trim().length > 3)
        .map((f: string) => f.trim().slice(0, 120))
        .slice(0, 3);
    }
  } catch { /* model ignored the schema: fall back to the raw text */ }

  const seen = new Set<string>();
  const sources = context.filter((c) => c.url && !seen.has(c.url!) && seen.add(c.url!))
    .map((c) => ({ label: c.title, url: c.url, score: c.score ?? null }))
    .slice(0, 6);

  return json({
    answer, followups, sources,
    person: person?.display_name ?? null,
    window: win,
    agenda_days: agendaDays,
    retrieved: context.length,
  });
});
