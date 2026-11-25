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
  });
  if (s.cover && !/^https:\/\//i.test(s.cover)) die("cover must be an https URL");
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
  const full = { v: 1, fid, title: spec.title, description: spec.description, cover: spec.cover, questions: spec.questions, topic, pk };
  const d = pack(full);
  const answerUrl = `${base}/form.html#d=${d}`;
  const secret = { fid, topic, jwk, title: spec.title, base, created: new Date().toISOString() };
  fs.writeFileSync(out, JSON.stringify(secret, null, 2), { mode: 0o600 });
  const shortAnswerUrl = process.argv.includes("--no-short") ? null : await shorten(answerUrl);
  const viewUrl = `${base}/view.html#t=${topic}&k=${b64u(Buffer.from(JSON.stringify(jwk)))}&d=${d}`;
  console.log(JSON.stringify({ shareUrl: shortAnswerUrl || answerUrl, shortAnswerUrl, answerUrl, viewUrl, secretFile: out, answerUrlLength: answerUrl.length, note: "Send shareUrl to people (short link; falls back to the long answerUrl if shortening failed). Keep the secret file private (never in a repo). The view link contains the private key: share it only with the form owner." }, null, 2));
  if (answerUrl.length > 3000) console.error("Warning: the answer link is long (" + answerUrl.length + " chars). Shorten texts or options so the WhatsApp button keeps working.");
}

function decode(url) { const p = frag(url); if (!p.d) die("no #d= part in the URL"); return unpack(p.d); }
async function cmdDecode(url) { const s = decode(await resolveUrl(url)); delete s.pk; delete s.topic; console.log(JSON.stringify(s, null, 2)); }

async function cmdPrefill(url, answersFile) {
  url = await resolveUrl(url);
  const s = decode(url);
  const a = readJson(answersFile);
  const clean = {};
  for (const q of s.questions) if (a[q.id] !== undefined && q.type !== "info") clean[q.id] = a[q.id];
  const base = url.split("#")[0];
  const long = `${base}#d=${frag(url).d}&r=${pack(clean)}`;
  // Answers are personal: shorten only when asked (--short), because the shortener sees the link.
  console.log((process.argv.includes("--short") && (await shorten(long))) || long);
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
  const st = fs.existsSync(stateFile) ? readJson(stateFile) : { seen: [], responses: [] };
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
  if (arg("all")) { console.log(JSON.stringify({ total: st.responses.length, responses: st.responses }, null, 2)); return; }
  console.log(JSON.stringify({ title: sec.title, newCount: fresh.length, total: st.responses.length, new: fresh }, null, 2));
}

async function cmdSummary(secretFile) {
  const { sec, st } = await sync(secretFile);
  const url = arg("form"); const s = url ? decode(await resolveUrl(url)) : null;
  const names = {}; if (s) s.questions.forEach((q) => (names[q.id] = q.text));
  const lines = [`${sec.title}: ${st.responses.length} response(s)`];
  st.responses.forEach((r, i) => { lines.push(`\n#${i + 1} (${r.receivedAt})`); for (const [k, v] of Object.entries(r.answers)) lines.push(`- ${names[k] || k}: ${Array.isArray(v) ? v.join(", ") : v}`); });
  console.log(lines.join("\n"));
}

const [cmd, a1, a2] = process.argv.slice(2);
const HELP = `form-tool.mjs
  create <spec.json> [--base URL] [--secret-out FILE] [--no-short]   make a form: prints shareUrl (short is.gd link, long fallback), answerUrl, viewUrl, writes a private secret file
  decode <answerUrl>                                     print the form (questions) from a link
  prefill <answerUrl> <answers.json> [--short]                  link with answers prefilled; the visitor presses Submit
  submit <answerUrl> <answers.json>                      send answers directly (ONLY after the visitor approved them)
  responses <secretFile> [--state FILE] [--all]          fetch, decrypt and archive new responses (JSON)
  summary <secretFile> [--form answerUrl]                text summary of archived responses, handy for WhatsApp`;
try {
  if (cmd === "create") await cmdCreate(a1);
  else if (cmd === "decode") await cmdDecode(a1);
  else if (cmd === "prefill") await cmdPrefill(a1, a2);
  else if (cmd === "submit") await cmdSubmit(a1, a2);
  else if (cmd === "responses") await cmdResponses(a1);
  else if (cmd === "summary") await cmdSummary(a1);
  else console.log(HELP);
} catch (e) { die(e.message); }
