import { notion } from "@/lib/notion";

// Team-EOD accountability assistant.
//
// Replaces the claude.ai cloud routine "⚡ Daily Team EOD Review" (silenced
// 7 Jul 2026). TEAM-FACING: each weekday it reviews each member's most recent
// UN-reviewed scorecard and posts a coaching comment ON THEIR row (@mention),
// in Asad's assistant voice, against the standard written into the scorecard's
// own field descriptions (Hormozi EOD: the blocker is the ONE binding
// constraint, never "none"). It praises only substantiated wins and calls out
// skipped/faked blockers + zero-output days, with prev-day continuity.
//
// The founder surface is SLACK (#ai-convo-landing-page) — a concise daily digest
// with escalations, per-person status, scorecard links, and (Mondays) a
// prior-week review. There is NO daily Notion task (the recurring review task was
// retired 9 Jul 2026 — it cluttered Asad's Actions).
//
// Flow (GET, weekday cron 30 6 * * 1-5):
//   1. Pull recent scorecards.
//   2. Per member: take their LATEST scorecard within lookback. If our bot
//      already commented it, skip; else coach + post a comment on that row.
//      Decoupled per person, so a miss/late/weekend row on one doesn't affect the
//      other, and an older un-reviewed row still gets picked up.
//   3. Post a founder digest to Slack (once per real run, when new comments post).
// ?dry=1 generates everything and returns it as JSON (incl. the Slack preview)
// without posting anything.

const SCORECARDS_DB_ID = "9dfdc9d7735941088a66b4c8978a54ca";
const LOOKBACK_DAYS = 14; // 2 weeks of history for trend + weekly context

// Expected team roster.
const ROSTER: { id: string; name: string }[] = [
  { id: "ac601ede-0d62-4107-b59e-21c0530b5348", name: "Akmal" },
  { id: "5205445e-a97c-406f-aca0-2671a339085e", name: "Sidra Imtiaz" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = Record<string, any>;

function richText(prop: AnyProps | undefined): string {
  const arr = prop?.rich_text;
  return Array.isArray(arr) ? arr.map((r) => r.plain_text ?? "").join("") : "";
}

function titleText(prop: AnyProps | undefined): string {
  const arr = prop?.title;
  return Array.isArray(arr) ? arr.map((r) => r.plain_text ?? "").join("") : "";
}

// London-local YYYY-MM-DD for an offset of `days` from now (negative = past).
function londonDate(days = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Date-string helpers (weekday of a calendar date is TZ-independent at UTC midnight).
function isoAddDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayOfWeek(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay(); // 0 = Sun, 6 = Sat
}
function previousWorkday(iso: string): string {
  let d = isoAddDays(iso, -1);
  while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) d = isoAddDays(d, -1);
  return d;
}
function scorecardRowUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}
function snip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

// The work-day a scorecard reports for lives in its title as a leading ISO
// datetime; fall back to created_time if the title isn't parseable.
function scorecardWorkDay(page: AnyProps): string {
  const title = titleText(page.properties?.Name);
  const m = title.match(/\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  return (page.created_time as string).slice(0, 10);
}

type PrevContext = {
  day: string;
  output: number | null;
  winBlocker: string;
  botCommented: boolean; // did we leave a note on that row?
  replied: boolean; // did THIS member reply after our note?
  replyText: string;
};

// Assistant reply addressed to the team member. Returns null on any failure so
// the caller degrades gracefully (no comment posted).
async function assistantComment(input: {
  name: string;
  hours: string;
  output: number | null;
  clean: boolean;
  winBlocker: string;
  recentOutputs: (number | null)[]; // prior work-days, newest first, excl. today
  prev: PrevContext | null; // their previous scorecard + whether they replied
}): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const zeroDays = input.recentOutputs.filter((o) => (o ?? 0) === 0).length;
  const trend = input.recentOutputs.length
    ? `Recent output before today (newest first): [${input.recentOutputs
        .map((o) => (o ?? "n/a"))
        .join(", ")}]. Zero-output days in that stretch: ${zeroDays} of ${input.recentOutputs.length}.`
    : "No prior scorecards in the last two weeks.";

  let prevBlock = "No previous scorecard to compare against.";
  if (input.prev) {
    const p = input.prev;
    prevBlock = `Their previous work-day (${p.day}): Output ${p.output ?? "n/a"}. Win + blocker: ${
      p.winBlocker || "(blank)"
    }.`;
    if (p.botCommented) {
      prevBlock += p.replied
        ? ` After your note that day, they replied: "${p.replyText}".`
        : ` They did NOT reply to your note that day.`;
    }
  }

  const prompt = `You are Asad's end-of-day accountability assistant for his team. You review a team member's daily EOD scorecard and reply DIRECTLY TO THEM (address them as "you"), in Asad's assistant voice: warm and encouraging, but no-BS. Asad reads every one of these, so they should feel his attention on their scorecard.

The reporting standard (from the scorecard's own field descriptions — hold them to it):
- Win + blocker: one sentence on the biggest thing they SHIPPED today, AND one sentence on their single biggest blocker. Both sentences are mandatory.
- Output: number of deliverables that LEFT THEIR HANDS today (not effort, not learning, not activity).
- Hours: time actively executing (meetings, planning, and gaps do not count).
- All clean?: honest — unticked if anything shipped had avoidable errors, missed follow-ups, or rework.

What a real blocker is (this is where they cut corners): the ONE binding constraint, the single thing that, if removed, would let them do more or better tomorrow. There is ALWAYS one. It is NOT "nothing blocked me" or "none", and it is NOT an environmental grumble like "internet was down" or "no work assigned" unless that genuinely is the main thing limiting how much they get done and they say what they need to clear it.

Their report for today:
Name: ${input.name}
Hours: ${input.hours || "(blank)"}
Output: ${input.output ?? "(blank)"}
All clean?: ${input.clean ? "Yes" : "No"}
Win + blocker: ${input.winBlocker || "(blank)"}
${trend}
${prevBlock}

Write a 2-4 sentence reply to ${input.name}:
- If there is a genuine, specific win, name it and give real credit. Do NOT celebrate a vague or unsubstantiated win, and do NOT celebrate if Output is 0 or the hours do not support it — instead ask what actually shipped.
- If the blocker is missing, "none", or an environmental excuse, tell them plainly that is not a blocker and ask for their real constraint: the one thing slowing them from doing better, and what they need from Asad to clear it.
- If Output is 0 (or it is another zero-output day in the trend), push them to turn the effort into one concrete deliverable that leaves their hands tomorrow.
- Keep it tight and human (2-3 sentences is plenty). Do not repeat their name at the start (they are already tagged). No greeting, no sign-off.
- Write the way Asad actually texts: plain and direct. NEVER use em dashes or en dashes (—, –) anywhere; use full stops, commas, or brackets instead. No corporate or hype words (leverage, unlock, throughput, compound, deliverable-speak). Do not use the "not X, it's Y" construction.
- Do not invent statistics. If you mention how many zero-output days there have been, use exactly the numbers given in the "Recent output" line above and nothing else.
- Use the previous work-day line for continuity, briefly. If they replied to your last note, acknowledge what they said and hold them to it. If they did NOT reply to your last note (especially if you asked for their real blocker), point that out plainly and ask again. Do not repeat your previous note word for word.

Return ONLY the reply text: no preamble, no reasoning, no quotes, no headers.`;

  return callClaude(prompt, 400);
}

// Prior-week readout for Asad (founder-facing only, not sent to the team).
async function weeklyReview(
  people: {
    name: string;
    days: { day: string; output: number | null; winBlocker: string }[];
    outputSum: number;
    submitted: number;
    zeroDays: number;
  }[],
): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const body = people
    .map((p) => {
      const lines = p.days
        .map((d) => `  ${d.day}: output ${d.output ?? "n/a"} - ${d.winBlocker || "(blank)"}`)
        .join("\n");
      return `${p.name}: submitted ${p.submitted}/5, total output ${p.outputSum}, zero-output days ${p.zeroDays}\n${lines}`;
    })
    .join("\n\n");
  const prompt = `You are Asad's assistant. Below is last week's EOD data for his team. Write a SHORT week-in-review for ASAD (founder-facing, not for the team). For each person give at most 2 lines: what they actually shipped this week, and whether they named and made progress on a real blocker or kept dodging it. Be honest and specific. Flag anyone who logged hours but shipped little. Plain language, no em dashes, no hype words. Use only the numbers given. Start each person on a new line with their name. Return only the readout.

${body}`;
  return callClaude(prompt, 500);
}

// Shared raw call to the Anthropic API (opus, no thinking, text-only out).
async function callClaude(prompt: string, maxTokens: number): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error("[team-eod-digest] Claude error:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text: string = Array.isArray(data?.content)
      ? data.content
          .filter((b: AnyProps) => b.type === "text")
          .map((b: AnyProps) => b.text ?? "")
          .join("")
          .trim()
      : "";
    return text || null;
  } catch (err) {
    console.error("[team-eod-digest] Claude fetch failed:", err);
    return null;
  }
}

// Founder digest to Slack. Env-gated + swallow-all so it can NEVER crash the cron.
async function postSlack(text: string, alert: boolean): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attachments: [
          {
            color: alert ? "#FF4444" : "#1EBA8F",
            blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
          },
        ],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[team-eod-digest] slack post failed:", err);
    return false;
  }
}

type Card = {
  person: string | null;
  workDay: string;
  createdTime: string;
  props: AnyProps;
  id: string;
};

type MemberResult = {
  name: string;
  submitted: boolean;
  lastDay?: string | null;
  stale?: boolean; // latest scorecard is older than the expected last work-day
  hours?: string;
  output?: number | null;
  clean?: boolean;
  winBlocker?: string;
  recentOutputs?: (number | null)[];
  comment?: string | null;
  posted?: boolean;
  alreadyCommented?: boolean;
  prevDay?: string | null;
  prevReplied?: boolean | null; // null = no prior note of ours to reply to
  rowUrl?: string;
};

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dry = new URL(request.url).searchParams.get("dry") === "1";

  try {
    const today = londonDate(0);
    const expectedLastWorkday = previousWorkday(today);
    const isMonday = dayOfWeek(today) === 1;

    // Pull recent scorecards (within lookback, prior to today).
    const cutoff = londonDate(-LOOKBACK_DAYS);
    const scorecards = await notion.databases.query({
      database_id: SCORECARDS_DB_ID,
      page_size: 100,
    });
    const cards: Card[] = scorecards.results
      .map((r) => {
        const props = ("properties" in r ? r.properties : {}) as AnyProps;
        const people = props.Person?.people ?? [];
        return {
          person: people[0]?.id ?? null,
          workDay: scorecardWorkDay(r as AnyProps),
          createdTime: ("created_time" in r ? (r.created_time as string) : "") ?? "",
          props,
          id: r.id,
        };
      })
      .filter((c) => c.workDay < today && c.workDay >= cutoff);

    // Our integration's bot user id — used for comment idempotency.
    let botId: string | null = null;
    try {
      botId = ((await notion.users.me({})) as AnyProps).id ?? null;
    } catch (err) {
      console.error("[team-eod-digest] users.me failed:", err);
    }

    // Per member: pick their most recent scorecard, coach, post comment.
    const results: MemberResult[] = [];
    for (const member of ROSTER) {
      const theirCards = cards
        .filter((c) => c.person === member.id)
        .sort((a, b) =>
          a.workDay !== b.workDay
            ? a.workDay < b.workDay
              ? 1
              : -1
            : a.createdTime < b.createdTime
            ? 1
            : -1,
        );
      const card = theirCards[0] ?? null;

      if (!card) {
        results.push({ name: member.name, submitted: false, lastDay: null, stale: true });
        continue;
      }

      const day = card.workDay;
      const hours = richText(card.props.Hours);
      const output = card.props.Output?.number ?? null;
      const clean = card.props["All clean?"]?.checkbox ?? false;
      const winBlocker = richText(card.props["Win + blocker"]);

      // Trend + prev: their prior work-days (latest row per day), before `day`.
      const byDay = new Map<string, Card>();
      for (const c of theirCards) {
        if (c.workDay >= day) continue;
        const cur = byDay.get(c.workDay);
        if (!cur || c.createdTime > cur.createdTime) byDay.set(c.workDay, c);
      }
      const priorDaysDesc = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const recentOutputs = priorDaysDesc.slice(0, 5).map(([, c]) => c.props.Output?.number ?? null);

      // Previous scorecard + did they reply to the note we left on it?
      let prev: PrevContext | null = null;
      const prevEntry = priorDaysDesc[0] ?? null;
      if (prevEntry) {
        const [prevDay, prevCard] = prevEntry;
        let botCommented = false;
        let replied = false;
        let replyText = "";
        try {
          const cs = await notion.comments.list({ block_id: prevCard.id });
          const sorted = [...cs.results].sort((a, b) =>
            (a.created_time as string) < (b.created_time as string) ? -1 : 1,
          );
          const lastBot = [...sorted]
            .reverse()
            .find((c) => botId != null && (c.created_by as AnyProps)?.id === botId);
          botCommented = !!lastBot;
          if (lastBot) {
            const after = sorted.filter(
              (c) =>
                (c.created_time as string) > (lastBot.created_time as string) &&
                (c.created_by as AnyProps)?.id === member.id,
            );
            if (after.length) {
              replied = true;
              replyText = after
                .map((c) =>
                  ((c as AnyProps).rich_text || [])
                    .map((r: AnyProps) => r.plain_text ?? "")
                    .join(""),
                )
                .join(" | ")
                .trim();
            }
          }
        } catch (err) {
          console.error("[team-eod-digest] prev comments.list failed:", err);
        }
        prev = {
          day: prevDay,
          output: prevCard.props.Output?.number ?? null,
          winBlocker: richText(prevCard.props["Win + blocker"]),
          botCommented,
          replied,
          replyText,
        };
      }

      const comment = await assistantComment({
        name: member.name,
        hours,
        output,
        clean,
        winBlocker,
        recentOutputs,
        prev,
      });

      // Idempotency: has our bot already commented on this row?
      let alreadyCommented = false;
      try {
        const existing = await notion.comments.list({ block_id: card.id });
        alreadyCommented = existing.results.some(
          (c) => botId != null && (c.created_by as AnyProps)?.id === botId,
        );
      } catch (err) {
        console.error("[team-eod-digest] comments.list failed:", err);
      }

      let posted = false;
      if (comment && !dry && !alreadyCommented) {
        try {
          await notion.comments.create({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parent: { page_id: card.id } as any,
            rich_text: [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { type: "mention", mention: { type: "user", user: { id: member.id } } } as any,
              { type: "text", text: { content: " " + comment } },
            ],
          });
          posted = true;
        } catch (err) {
          console.error("[team-eod-digest] comment post failed:", member.name, err);
        }
      }

      results.push({
        name: member.name,
        submitted: true,
        lastDay: day,
        stale: day < expectedLastWorkday,
        hours,
        output,
        clean,
        winBlocker,
        recentOutputs,
        comment,
        posted,
        alreadyCommented,
        prevDay: prev?.day ?? null,
        prevReplied: prev?.botCommented ? prev.replied : null,
        rowUrl: scorecardRowUrl(card.id),
      });
    }

    // Escalations (objective chronic-pattern flags for Asad).
    const escalations: string[] = [];
    for (const r of results) {
      if (!r.submitted) {
        escalations.push(`${r.name} has no EOD in the last ${LOOKBACK_DAYS} days.`);
        continue;
      }
      if (r.stale) escalations.push(`${r.name} hasn't submitted since ${r.lastDay}.`);
      const recentZeros = (r.recentOutputs ?? []).filter((o) => (o ?? 0) === 0).length;
      const zeros = ((r.output ?? 0) === 0 ? 1 : 0) + recentZeros;
      const windowN = 1 + (r.recentOutputs?.length ?? 0);
      if ((r.output ?? null) === 0 && zeros >= 3) {
        escalations.push(`${r.name}: ${zeros} zero-output days in the last ${windowN}.`);
      }
    }

    // Weekly review (Mondays only, founder-facing).
    let weekly: { text: string; range: string } | null = null;
    if (isMonday) {
      const prevFriday = expectedLastWorkday; // on Monday = last Friday
      const prevMonday = isoAddDays(prevFriday, -4);
      const people = ROSTER.map((m) => {
        const daysMap = new Map<string, Card>();
        for (const c of cards) {
          if (c.person !== m.id || c.workDay < prevMonday || c.workDay > prevFriday) continue;
          const cur = daysMap.get(c.workDay);
          if (!cur || c.createdTime > cur.createdTime) daysMap.set(c.workDay, c);
        }
        const days = [...daysMap.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([d, c]) => ({
            day: d,
            output: c.props.Output?.number ?? null,
            winBlocker: richText(c.props["Win + blocker"]),
          }));
        return {
          name: m.name,
          days,
          outputSum: days.reduce((s, d) => s + (d.output ?? 0), 0),
          submitted: days.length,
          zeroDays: days.filter((d) => (d.output ?? 0) === 0).length,
        };
      });
      const text = await weeklyReview(people);
      if (text) weekly = { text, range: `${prevMonday} to ${prevFriday}` };
    }

    // Founder digest → Slack (the only founder surface; no Notion task).
    const slackLines: string[] = [`*Team EOD — ${today}*`];
    if (escalations.length) {
      slackLines.push(":rotating_light: *Needs attention*");
      for (const e of escalations) slackLines.push(`• ${e}`);
    }
    for (const r of results) {
      if (!r.submitted) {
        slackLines.push(`*${r.name}* — no EOD in the last ${LOOKBACK_DAYS} days`);
        continue;
      }
      const flag = (r.output ?? 0) === 0 ? " ⚠️" : "";
      const reviewed = r.posted ? "" : r.alreadyCommented ? " · already reviewed" : "";
      slackLines.push(
        `*${r.name}* (${r.lastDay}) — output ${r.output ?? "n/a"}${flag}${reviewed}  <${r.rowUrl}|scorecard>`,
      );
      if (r.comment) slackLines.push(`> ${snip(r.comment, 260)}`);
    }
    if (weekly) {
      slackLines.push(`*Week in review* (${weekly.range})`);
      slackLines.push(weekly.text);
    }
    const slackText = slackLines.join("\n");

    // Send once per real run — tied to at least one new comment being posted, so
    // manual re-runs and Vercel retries don't double-post.
    let slackSent = false;
    if (!dry && results.some((r) => r.posted)) {
      slackSent = await postSlack(slackText, escalations.length > 0);
    }

    return Response.json({
      dry,
      today,
      isMonday,
      escalations,
      weekly: weekly?.range ?? null,
      slackConfigured: !!process.env.SLACK_WEBHOOK_URL,
      slackSent,
      slackText,
      results,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[team-eod-digest] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
