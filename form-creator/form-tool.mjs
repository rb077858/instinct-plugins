#!/usr/bin/env node
// form-tool.mjs - helper for the instinct-plugins "form-creator" plugin.
// Zero dependencies. Needs Node 18+. Run: node form-tool.mjs help
import { webcrypto as crypto } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import fs from "node:fs";

const DEFAULT_BASE = "https://reembir.com/instinct-plugins/form-creator";
const NTFY = "https://ntfy.sh";
const b64u = (u) => Buffer.from(u).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const pack = (obj) => b64u(deflateRawSync(Buffer.from(JSON.stringify(obj))));
const unpack = (s) => JSON.parse(inflateRawSync(Buffer.from(s, "base64url")).toString());
const die = (m) => { console.error("Error: " + m); process.exit(1); };

const TYPES = ["short", "long", "single", "multi", "dropdown", "scale", "rating", "number", "date", "email", "info"];

function validateSpec(s) {
  if (!s || typeof s !== "object") die("spec must be a JSON object");
  if (!s.title || typeof s.title !== "string") die("spec.title is required");
  if (!Array.isArray(s.questions) || !s.questions.length) die("spec.questions must be a non-empty list");
  if (s.questions.length > 30) die("at most 30 questions");
  const ids = new Set();
  s.questions.forEach((q, i) => {
    q.id = String(q.id || "q" + (i + 1));
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(q.id)) die(`question ${i + 1}: id must be letters, digits, - or _`);
    if (ids.has(q.id)) die("duplicate question id " + q.id);
    ids.add(q.id);
    if (!TYPES.includes(q.type)) die(`question ${q.id}: type must be one of ${TYPES.join(", ")}`);
    if (!q.text) die(`question ${q.id}: text is required`);
    if (["single", "multi", "dropdown"].includes(q.type) && (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 20)) die(`question ${q.id}: needs 2 to 20 options`);
    for (const u of [q.image, ...(q.options || []).map((o) => o && o.image)]) if (u && !/^https:\/\//i.test(u)) die(`question ${q.id}: images must be https URLs`);
    if (q.points !== undefined && (typeof q.points !== "number" || !(q.points > 0) || q.points > 100)) die(`question ${q.id}: points must be a number above 0 and at most 100`);
    if (q.correct !== undefined) {
      if (!["single", "multi", "dropdown"].includes(q.type)) die(`question ${q.id}: correct answers are only for single, multi and dropdown`);
      const labels = (q.options || []).map((o) => (typeof o === "string" ? o : o && o.label));
      if (q.type === "multi" && !Array.isArray(q.correct)) die(`question ${q.id}: multi needs a list of correct options`);
      if (q.type !== "multi" && Array.isArray(q.correct)) die(`question ${q.id}: ${q.type} needs one correct option (a string)`);
      const want = Array.isArray(q.correct) ? q.correct : [q.correct];
      if (!want.length || want.some((w) => typeof w !== "string" || !labels.includes(w))) die(`question ${q.id}: correct must be one of the options`);
    }
    if (q.partial && !(q.type === "multi" && Array.isArray(q.correct))) die(`question ${q.id}: partial credit is only for multi questions with correct answers`);
  });
  if (s.cover && !/^https:\/\//i.test(s.cover)) die("cover must be an https URL");
  if (s.instant && !s.questions.some((q) => q.correct !== undefined)) die("instant feedback needs at least one question with a correct answer");
}

// Quiz support: the key holds points and correct answers. It NEVER goes into the link unless the
// creator chose instant feedback. Grading happens here, on the creator's side.
function extractKey(s) {
  const key = {};
  for (const q of s.questions) {
    if (q.correct === undefined && q.points === undefined) continue;
    const e = { p: q.points != null ? q.points : 1 };
    if (q.correct !== undefined) e.c = q.correct;
    if (q.partial) e.part = true;
    key[q.id] = e;
  }
  return Object.keys(key).length ? key : null;
}
function gradeAnswers(key, answers) {
  let score = 0, max = 0; const pending = [];
  for (const [qid, e] of Object.entries(key)) {
    max += e.p;
    if (e.c === undefined) { pending.push(qid); continue; }
    const a = answers[qid];
    if (Array.isArray(e.c)) {
      const sel = Array.isArray(a) ? a : [];
      if (e.part) {
        const right = sel.filter((x) => e.c.includes(x)).length;
        const wrong = sel.filter((x) => !e.c.includes(x)).length;
        score += (Math.max(0, right - wrong) / e.c.length) * e.p;
      } else if (sel.length === e.c.length && sel.every((x) => e.c.includes(x))) score += e.p;
    } else if (typeof a === "string" && a === e.c) score += e.p;
  }
  return { score: Math.round(score * 100) / 100, max, pending };
}
function scoreOf(sec, st, r) {
  const g = gradeAnswers(sec.key, r.answers);
  const manual = (st.manual && st.manual[r.id]) || {};
  let mTotal = 0;
  for (const pts of Object.values(manual)) mTotal += pts;
  return { auto: g.score, manual: mTotal || undefined, total: Math.round((g.score + mTotal) * 100) / 100, max: g.max, pending: g.pending.filter((qid) => manual[qid] === undefined) };
}

async function genKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { jwk, pk: b64u(raw) };
}
const rnd = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

async function encryptTo(pkB64, plain) {
  const pub = await crypto.subtle.importKey("raw", unb64u(pkB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, deflateRawSync(Buffer.from(JSON.stringify(plain)))));
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  return JSON.stringify({ v: 1, e: b64u(epk), n: b64u(iv), c: b64u(ct) });
}
async function decryptWith(jwk, msg) {
  const m = JSON.parse(msg);
  if (m.v !== 1) throw new Error("unknown version");
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const pub = await crypto.subtle.importKey("raw", unb64u(m.e), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(m.n) }, key, unb64u(m.c));
  return JSON.parse(inflateRawSync(Buffer.from(pt)).toString());
}

function frag(url) {
  const i = url.indexOf("#");
  const p = {};
  if (i >= 0) url.slice(i + 1).split("&").forEach((kv) => { const j = kv.indexOf("="); if (j > 0) p[kv.slice(0, j)] = kv.slice(j + 1); });
  return p;
}
// Link shortener: is.gd (free, no signup). It sees the whole link it is given, fragment included.
// Never shorten a viewUrl (it holds the private key). The result is verified; on any failure we return null.
async function shorten(url) {
  try {
    const r = await fetch("https://is.gd/create.php?format=simple&url=" + encodeURIComponent(url), { signal: AbortSignal.timeout(15000) });
    const short = (await r.text()).trim();
    if (!r.ok || !/^https:\/\/is\.gd\/[A-Za-z0-9_]+$/.test(short)) return null;
    const h = await fetch(short, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    return h.headers.get("location") === url ? short : null;
  } catch { return null; }
}
async function resolveUrl(url) {
  if (!/^https:\/\/is\.gd\/[A-Za-z0-9_]+$/.test(url)) return url;
  const h = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  const loc = h.headers.get("location");
  if (!loc) die("short link did not resolve");
  return loc;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { die(`cannot read JSON file ${f}: ${e.message}`); } }
function arg(name, def) { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : def; }

async function cmdCreate(specFile) {
  const spec = readJson(specFile);
  validateSpec(spec);
  const base = (arg("base", DEFAULT_BASE)).replace(/\/$/, "");
  const out = arg("secret-out", `./form-${rnd(4)}.secret.json`);
  const { jwk, pk } = await genKeys();
  const topic = "ifp-" + rnd(18);
  const fid = rnd(6);
  const key = extractKey(spec);
  // The public payload never carries points or correct answers; instant mode embeds the whole key.
  const pubQuestions = spec.questions.map((q) => { const { correct, points, partial, ...rest } = q; return rest; });
  const full = { v: 1, fid, title: spec.title, description: spec.description, cover: spec.cover, questions: pubQuestions, topic, pk };
  if (key) { full.qz = 1; if (spec.instant) full.qk = key; }
  const d = pack(full);
  const answerUrl = `${base}/form.html#d=${d}`;
  const secret = { fid, topic, jwk, title: spec.title, base, created: new Date().toISOString() };
  if (key) { secret.key = key; secret.instant = !!spec.instant; }
  fs.writeFileSync(out, JSON.stringify(secret, null, 2), { mode: 0o600 });
  let shortAnswerUrl = null;
  if (!process.argv.includes("--no-short")) {
    shortAnswerUrl = (await shorten(answerUrl)) || (await shorten(answerUrl)); // one retry: is.gd is a free service
  }
  let viewUrl = `${base}/view.html#t=${topic}&k=${b64u(Buffer.from(JSON.stringify(jwk)))}&d=${d}`;
  if (key) viewUrl += `&qk=${pack(key)}`;
  console.log(JSON.stringify({ shareUrl: shortAnswerUrl || answerUrl, shortAnswerUrl, answerUrl, viewUrl, secretFile: out, answerUrlLength: answerUrl.length, quiz: key ? { scoredQuestions: Object.keys(key).length, instant: !!spec.instant } : undefined, note: "Hand out ONLY shareUrl (the short is.gd link). The long answerUrl is an internal fallback: use it only when shortening failed, and never show it otherwise. Keep the secret file private (never in a repo): for a quiz it holds the answer key. The view link contains the private key (and the quiz key): share it only with the form owner." }, null, 2));
  if (key && spec.instant) console.error("Instant feedback: the answer key is inside the link. Anyone who opens the page source can read the answers.");
  if (answerUrl.length > 3000) console.error("Warning: the answer link is long (" + answerUrl.length + " chars). Shorten texts or options so the WhatsApp button keeps working.");
}

function decode(url) { const p = frag(url); if (!p.d) die("no #d= part in the URL"); return unpack(p.d); }
async function cmdDecode(url) { const s = decode(await resolveUrl(url)); delete s.pk; delete s.topic; delete s.qk; console.log(JSON.stringify(s, null, 2)); }

async function cmdPrefill(url, answersFile) {
  url = await resolveUrl(url);
  const s = decode(url);
  const a = readJson(answersFile);
  const clean = {};
  for (const q of s.questions) if (a[q.id] !== undefined && q.type !== "info") clean[q.id] = a[q.id];
  const base = url.split("#")[0];
  const long = `${base}#d=${frag(url).d}&r=${pack(clean)}`;
  // Short by default: the owner asked to always hand out the short link. The shortener can read
  // the answers inside the link, so pass --no-short for sensitive answers.
  if (process.argv.includes("--no-short")) { console.log(long); return; }
  console.log((await shorten(long)) || (await shorten(long)) || long);
}

async function cmdSubmit(url, answersFile) {
  url = await resolveUrl(url);
  const s = decode(url);
  const a = readJson(answersFile);
  const msg = await encryptTo(s.pk, { f: s.fid || "", t: Date.now(), a, via: "assistant" });
  if (msg.length > 3900) die("answers too long for one message; shorten them");
  const r = await fetch(`${NTFY}/${s.topic}`, { method: "POST", body: msg, headers: { "Content-Type": "text/plain" } });
  if (!r.ok) die("send failed: HTTP " + r.status);
  console.log("sent");
}

async function fetchMessages(topic, since) {
  const r = await fetch(`${NTFY}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`);
  if (!r.ok) die("ntfy HTTP " + r.status);
  return (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
}

async function sync(secretFile) {
  const sec = readJson(secretFile);
  const stateFile = arg("state", secretFile.replace(/\.secret\.json$/, "") + ".archive.json");
  const st = fs.existsSync(stateFile) ? readJson(stateFile) : { seen: [], responses: [], manual: {} };
  st.manual = st.manual || {};
  const msgs = await fetchMessages(sec.topic, "all");
  const fresh = [];
  for (const m of msgs) {
    if (st.seen.includes(m.id)) continue;
    st.seen.push(m.id);
    try {
      const p = await decryptWith(sec.jwk, m.message);
      if (p.f !== sec.fid) continue;
      const rec = { id: m.id, receivedAt: new Date(m.time * 1000).toISOString(), via: p.via, answers: p.a };
      st.responses.push(rec); fresh.push(rec);
    } catch { /* not decryptable: ignore junk */ }
  }
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), { mode: 0o600 });
  return { sec, st, fresh };
}

async function cmdResponses(secretFile) {
  const { sec, st, fresh } = await sync(secretFile);
  const scored = (r) => (sec.key ? { ...r, score: scoreOf(sec, st, r) } : r);
  if (arg("all")) { console.log(JSON.stringify({ total: st.responses.length, responses: st.responses.map(scored) }, null, 2)); return; }
  console.log(JSON.stringify({ title: sec.title, newCount: fresh.length, total: st.responses.length, new: fresh.map(scored) }, null, 2));
}

// Manual grading for open questions: grade <secretFile> --response N --question qID --points X
async function cmdGrade(secretFile) {
  const { sec, st } = await sync(secretFile);
  if (!sec.key) die("this form is not a quiz (no answer key in the secret file)");
  const rArg = arg("response"), qid = arg("question"), pts = arg("points");
  if (!rArg || !qid || pts === undefined) die("usage: grade <secretFile> --response N --question qID --points X");
  const idx = /^\d+$/.test(rArg) ? parseInt(rArg, 10) - 1 : st.responses.findIndex((r) => r.id === rArg);
  if (idx < 0 || !st.responses[idx]) die("no such response (use its number from summary or its id)");
  const e = sec.key[qid];
  if (!e) die(`question ${qid} is not a scored question`);
  if (e.c !== undefined) die(`question ${qid} is auto-graded; only open questions take manual points`);
  const p = Number(pts);
  if (!isFinite(p) || p < 0 || p > e.p) die(`points must be between 0 and ${e.p}`);
  const stateFile = arg("state", secretFile.replace(/\.secret\.json$/, "") + ".archive.json");
  (st.manual[st.responses[idx].id] = st.manual[st.responses[idx].id] || {})[qid] = p;
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), { mode: 0o600 });
  const sc = scoreOf(sec, st, st.responses[idx]);
  console.log(JSON.stringify({ response: idx + 1, question: qid, manualPoints: p, total: sc.total, max: sc.max, stillPending: sc.pending }, null, 2));
}

async function cmdSummary(secretFile) {
  const { sec, st } = await sync(secretFile);
  const url = arg("form"); const s = url ? decode(await resolveUrl(url)) : null;
  const names = {}; if (s) s.questions.forEach((q) => (names[q.id] = q.text));
  if (!sec.key) {
    const lines = [`${sec.title}: ${st.responses.length} response(s)`];
    st.responses.forEach((r, i) => { lines.push(`\n#${i + 1} (${r.receivedAt})`); for (const [k, v] of Object.entries(r.answers)) lines.push(`- ${names[k] || k}: ${Array.isArray(v) ? v.join(", ") : v}`); });
    console.log(lines.join("\n"));
    return;
  }
  const lines = [`${sec.title}: ${st.responses.length} response(s), quiz mode${sec.instant ? " (instant feedback)" : ""}`];
  const graded = st.responses.map((r, i) => ({ i, r, sc: scoreOf(sec, st, r) }));
  if (graded.length) {
    lines.push(`Max score: ${graded[0].sc.max}`, "", "Ranking:");
    [...graded].sort((a, b) => b.sc.total - a.sc.total).forEach((g, rank) => {
      const pend = g.sc.pending.length ? ` [pending manual: ${g.sc.pending.join(", ")}]` : "";
      lines.push(`${rank + 1}. ${g.sc.total}/${g.sc.max} - response #${g.i + 1} (${g.r.receivedAt})${pend}`);
    });
  }
  graded.forEach((g) => {
    lines.push(`\n#${g.i + 1} (${g.r.receivedAt}) - ${g.sc.total}/${g.sc.max}${g.sc.pending.length ? ` [pending: ${g.sc.pending.join(", ")}]` : ""}`);
    for (const [k, v] of Object.entries(g.r.answers)) {
      const e = sec.key[k];
      let mark = "";
      if (e) {
        const m = st.manual[g.r.id] || {};
        if (e.c === undefined) mark = m[k] !== undefined ? ` - manual ${m[k]}/${e.p}` : ` - pending manual (max ${e.p})`;
        else mark = ` - ${gradeAnswers({ [k]: e }, g.r.answers).score}/${e.p}`;
      }
      lines.push(`- ${names[k] || k}: ${Array.isArray(v) ? v.join(", ") : v}${mark}`);
    }
  });
  console.log(lines.join("\n"));
}

const [cmd, a1, a2] = process.argv.slice(2);
const HELP = `form-tool.mjs
  create <spec.json> [--base URL] [--secret-out FILE] [--no-short]   make a form: prints shareUrl (the short link to hand out), the long answerUrl (internal fallback only), viewUrl, writes a private secret file
  decode <answerUrl>                                     print the form (questions) from a link
  prefill <answerUrl> <answers.json> [--no-short]               short link with answers prefilled; the visitor presses Submit (--no-short keeps answers away from the shortener)
  submit <answerUrl> <answers.json>                      send answers directly (ONLY after the visitor approved them)
  responses <secretFile> [--state FILE] [--all]          fetch, decrypt and archive new responses (JSON; quizzes include scores)
  summary <secretFile> [--form answerUrl]                text summary of archived responses, handy for WhatsApp; quizzes get a ranking
  grade <secretFile> --response N --question qID --points X   give manual points for an open quiz question`;
try {
  if (cmd === "create") await cmdCreate(a1);
  else if (cmd === "decode") await cmdDecode(a1);
  else if (cmd === "prefill") await cmdPrefill(a1, a2);
  else if (cmd === "submit") await cmdSubmit(a1, a2);
  else if (cmd === "responses") await cmdResponses(a1);
  else if (cmd === "summary") await cmdSummary(a1);
  else if (cmd === "grade") await cmdGrade(a1);
  else console.log(HELP);
} catch (e) { die(e.message); }
