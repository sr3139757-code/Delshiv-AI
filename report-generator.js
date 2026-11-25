// Automated Report Generator for Delshiv AI.
// Deterministic: every number comes from real data passed in; missing data is stated as a gap, never invented.

export const AUDIENCES = ["executive", "technical", "client"];

const REDACTIONS = [
  [/AIza[0-9A-Za-z_-]{25,60}/g, "[REDACTED_API_KEY]"],
  [/\bAQ\.[0-9A-Za-z_.-]{20,120}/g, "[REDACTED_API_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_API_KEY]"],
  [/\btvly-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi, "Bearer [REDACTED_TOKEN]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"',;]+/gi, "$1=[REDACTED]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/(C:\\Users\\)[^\\\s]+/gi, "$1<user>"],
];

const EMAIL_RE = REDACTIONS[7][0];

export function redact(text, { redactEmails = true } = {}) {
  let out = String(text ?? "");
  for (const [re, rep] of REDACTIONS) {
    if (!redactEmails && re === EMAIL_RE) continue;
    out = out.replace(re, rep);
  }
  return out;
}

const cell = (s) => redact(String(s ?? "")).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const fmtDate = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const GAP = (what) => `*[Data unavailable: ${what}]*`;

function inRange(iso, from, to) {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= from && t <= to;
}

function limitFor(audience) {
  return audience === "executive" ? 5 : audience === "client" ? 8 : 15;
}

/**
 * data: { tasks[], notes[], schedule[], errors[], behavior|null, git: {commits[]}|null, gitGap?: string, rawNotes?: string }
 */
export function buildReportMarkdown(data, { audience = "technical", title = "", days = 7, now = Date.now(), author = "Delshiv AI (Report Generator)" } = {}) {
  if (!AUDIENCES.includes(audience)) throw new Error(`audience must be one of: ${AUDIENCES.join(", ")}`);
  const nDays = Math.min(365, Math.max(1, Math.floor(Number(days) || 7)));
  const to = now;
  const from = now - nDays * 24 * 3600 * 1000;
  const lim = limitFor(audience);

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const errors = (Array.isArray(data.errors) ? data.errors : []).filter((e) => inRange(e.timestamp, from, to));
  const schedule = Array.isArray(data.schedule) ? data.schedule : [];
  const commits = data.git && Array.isArray(data.git.commits) ? data.git.commits : null;

  const created = tasks.filter((t) => inRange(t.createdAt, from, to));
  const completed = tasks.filter((t) => t.status === "completed" && inRange(t.completedAt, from, to));
  const pending = tasks.filter((t) => t.status !== "completed");
  const stale = pending.filter((t) => Date.parse(t.createdAt) < now - 7 * 24 * 3600 * 1000);
  const denom = completed.length + pending.length;
  const completionRate = denom ? Math.round((completed.length / denom) * 100) : null;

  const errorGroups = new Map();
  for (const e of errors) {
    const k = String(e.action || "Unknown").replace(/\s*\(.*$/, "");
    const g = errorGroups.get(k) || { count: 0, last: e };
    g.count += 1;
    errorGroups.set(k, g);
  }
  const topErrors = [...errorGroups.entries()].sort((a, b) => b[1].count - a[1].count);
  const recurring = topErrors.filter(([, g]) => g.count >= 3);

  const reportTitle = redact(title) || `${audience[0].toUpperCase() + audience.slice(1)} Activity Report`;
  const L = [];

  // Title & metadata
  L.push(`# ${reportTitle}`, "");
  L.push("| Field | Value |", "|---|---|");
  L.push(`| Date range | ${fmtDate(new Date(from))} – ${fmtDate(new Date(to))} (${nDays} day${nDays > 1 ? "s" : ""}) |`);
  L.push(`| Generated | ${new Date(now).toLocaleString("en-IN")} |`);
  L.push(`| Author | ${author} |`);
  L.push(`| Audience | ${audience} |`, "");

  // Executive summary — templated from real numbers only
  const facts = [];
  facts.push(`${completed.length} task${completed.length === 1 ? "" : "s"} completed and ${pending.length} still pending`);
  if (commits) facts.push(`${commits.length} commit${commits.length === 1 ? "" : "s"} recorded`);
  if (audience !== "client") facts.push(`${errors.length} error${errors.length === 1 ? "" : "s"} logged`);
  const outlook = recurring.length || stale.length
    ? `Attention is needed on ${[recurring.length && `${recurring.length} recurring issue${recurring.length > 1 ? "s" : ""}`, stale.length && `${stale.length} task${stale.length > 1 ? "s" : ""} open over 7 days`].filter(Boolean).join(" and ")}.`
    : "No recurring issues or stale work were detected.";
  L.push("## Executive Summary", "", `During this period: ${facts.join(", ")}. ${outlook}`, "");

  // Key metrics
  L.push("## Key Metrics", "", "| Metric | Value |", "|---|---|");
  L.push(`| Tasks created | **${created.length}** |`);
  L.push(`| Tasks completed | **${completed.length}** |`);
  L.push(`| Tasks pending (all-time open) | **${pending.length}** |`);
  L.push(`| Completion rate | ${completionRate === null ? GAP("no tasks on record") : `**${completionRate}%**`} |`);
  if (audience !== "client") {
    L.push(`| Errors logged (in range) | **${errors.length}** |`);
    L.push(`| Active scheduled tasks | **${schedule.length}** |`);
  }
  L.push(`| Commits | ${commits ? `**${commits.length}**` : GAP(data.gitGap || "git history not accessible")} |`, "");

  // Detailed analysis
  L.push("## Detailed Analysis", "");
  L.push("### Tasks", "");
  if (!tasks.length) L.push(GAP("no tasks recorded"), "");
  else {
    if (completed.length) {
      L.push(`**Completed (${completed.length})**`, "");
      completed.slice(0, lim).forEach((t) => L.push(`- ✅ ${cell(t.title)}`));
      if (completed.length > lim) L.push(`- …and ${completed.length - lim} more`);
      L.push("");
    }
    if (pending.length) {
      L.push(`**Pending (${pending.length})**`, "");
      pending.slice(0, lim).forEach((t) => L.push(`- ⏳ ${cell(t.title)} — priority: ${cell(t.priority || "normal")}`));
      if (pending.length > lim) L.push(`- …and ${pending.length - lim} more`);
      L.push("");
    }
  }

  if (audience !== "client") {
    L.push("### Development Activity", "");
    if (!commits) L.push(GAP(data.gitGap || "git history not accessible"), "");
    else if (!commits.length) L.push("No commits in this period.", "");
    else {
      if (audience === "technical") {
        L.push("| Commit | Date | Message |", "|---|---|---|");
        commits.slice(0, lim).forEach((c) => L.push(`| \`${cell(c.hash)}\` | ${cell(c.date)} | ${cell(c.subject)} |`));
      } else {
        commits.slice(0, lim).forEach((c) => L.push(`- ${cell(c.subject)}`));
      }
      if (commits.length > lim) L.push("", `…and ${commits.length - lim} more commits`);
      L.push("");
    }

    L.push("### System Health", "");
    if (!errors.length) L.push("No errors were logged in this period.", "");
    else {
      L.push("| Source action | Occurrences | Latest message |", "|---|---|---|");
      topErrors.slice(0, lim).forEach(([k, g]) => L.push(`| ${cell(k)} | ${g.count} | ${cell(String(g.last.message || "").slice(0, 120))} |`));
      L.push("");
    }
    if (schedule.length && audience === "technical") {
      L.push("### Scheduled Automation", "", "| Task | Type | Next run |", "|---|---|---|");
      schedule.slice(0, lim).forEach((s) => L.push(`| ${cell(s.taskName)} | ${cell(s.scheduleType)} | ${cell(s.nextRun || new Date(s.nextRunAt).toLocaleString())} |`));
      L.push("");
    }
  }

  if (audience === "technical" && data.behavior?.stats) {
    const s = data.behavior.stats;
    L.push("### Assistant Usage (lifetime)", "", `- Messages: **${s.messages}**, style: ${cell(s.style)}`);
    if (s.topTools?.length) L.push(`- Top tools: ${s.topTools.map(([t, c]) => `${cell(t)} (${c})`).join(", ")}`);
    L.push("");
  }

  if (data.rawNotes && String(data.rawNotes).trim()) {
    L.push("### Notes Provided", "");
    redact(String(data.rawNotes).trim().slice(0, 4000)).split(/\r?\n/).filter(Boolean).slice(0, 40).forEach((l) => L.push(`> ${l}`));
    L.push("");
  }

  // Risks
  L.push("## Risks, Blockers & Issues", "");
  const risks = [];
  recurring.forEach(([k, g]) => risks.push(`**Recurring error** in \`${cell(k)}\` (${g.count}×) — latest: ${cell(String(g.last.message || "").slice(0, 100))}`));
  if (stale.length) risks.push(`**${stale.length} task${stale.length > 1 ? "s" : ""} pending for over 7 days**: ${stale.slice(0, 3).map((t) => cell(t.title)).join("; ")}`);
  if (commits === null && audience !== "client") risks.push("Development activity could not be measured (git history unavailable).");
  if (!risks.length) L.push("No significant risks detected from the available data.", "");
  else {
    L.push("> [!WARNING]");
    risks.slice(0, lim).forEach((r) => L.push(`> - ${r}`));
    L.push("");
  }

  // Action items — derived from real open items; owners/dates not in the data are marked as such
  L.push("## Action Items & Next Steps", "", "| # | Action | Owner | Timeline |", "|---|---|---|---|");
  const actions = [
    ...recurring.map(([k]) => `Investigate recurring failures in ${k}`),
    ...stale.slice(0, 5).map((t) => `Resolve or re-prioritise: ${t.title}`),
    ...pending.filter((t) => !stale.includes(t)).slice(0, 5).map((t) => `Complete: ${t.title}`),
  ].slice(0, lim);
  if (!actions.length) L.push("| – | No open actions identified | – | – |");
  else actions.forEach((a, i) => L.push(`| ${i + 1} | ${cell(a)} | [Not specified] | [Not specified] |`));
  L.push("", "---", `*Generated automatically by Delshiv AI. Sensitive values (keys, tokens, emails) are redacted.*`);

  return { markdown: L.join("\n"), title: reportTitle, metrics: { created: created.length, completed: completed.length, pending: pending.length, errors: errors.length, commits: commits ? commits.length : null, completionRate } };
}

// ───────── Markdown → standalone HTML (for the subset generated above) ─────────
export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function inline(s) {
  const escaped = esc(s);
  const codeSpans = [];
  const withTokens = escaped.replace(/`([^`]+)`/g, (_m, inner) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${inner.replace(/\\\|/g, "|")}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });
  const formatted = withTokens
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\\\|/g, "|");
  return formatted.replace(/\u0000CODE_(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] || "");
}

export function markdownToHtml(md, title = "Report") {
  const lines = String(md).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^#{1,3} /.test(ln)) {
      const lvl = ln.match(/^#+/)[0].length;
      out.push(`<h${lvl}>${inline(ln.replace(/^#+\s*/, ""))}</h${lvl}>`);
      i++;
    } else if (ln.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const split = (r) => r.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const head = split(rows[0]);
      const hasSeparator = rows.length > 1 && /^\|[\s:|\-]+\|$/.test(rows[1].trim()) && rows[1].includes("-");
      const body = (hasSeparator ? rows.slice(2) : rows.slice(1)).map(split);
      out.push("<table><thead><tr>" + head.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>" +
        body.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
    } else if (ln.startsWith(">")) {
      const q = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      const warn = q[0] === "[!WARNING]";
      out.push(`<blockquote${warn ? ' class="warn"' : ""}>${q.slice(warn ? 1 : 0).map((l) => (l.startsWith("- ") ? `<div>• ${inline(l.slice(2))}</div>` : `<div>${inline(l)}</div>`)).join("")}</blockquote>`);
    } else if (ln.startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      out.push("<ul>" + items.map((x) => `<li>${inline(x)}</li>`).join("") + "</ul>");
    } else if (ln.trim() === "---") {
      out.push("<hr>");
      i++;
    } else if (ln.trim()) {
      out.push(`<p>${inline(ln)}</p>`);
      i++;
    } else i++;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:15px/1.5 Segoe UI,Arial,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1f2937}
table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid #d1d5db;padding:6px 10px;text-align:left}th{background:#f3f4f6}
blockquote{margin:10px 0;padding:8px 14px;border-left:4px solid #9ca3af;background:#f9fafb}blockquote.warn{border-color:#f59e0b;background:#fffbeb}
code{background:#f3f4f6;padding:1px 4px;border-radius:3px}h1{border-bottom:2px solid #e5e7eb;padding-bottom:6px}
</style></head><body>${out.join("\n")}</body></html>`;
}
