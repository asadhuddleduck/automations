import { notion } from "@/lib/notion";
import { notify } from "@/lib/notify";

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
// The founder surface is SLACK. The digest goes through notify() at severity
// "human" (Asad has to read the team's scorecards and reply), so it routes to
// #alerts. It carries escalations, per-person status, scorecard links, and
// (Mondays) a prior-week review. There is NO daily Notion task (the recurring
// review task was retired 9 Jul 2026, it cluttered Asad's Actions).
//
// Flow (GET, weekday cron 30 6 * * 1-5):
//   1. Pull recent scorecards.
//   2. Per member: take their LATEST scorecard within lookback. If our bot
//      already commented it, skip; else coach + post a comment on that row.
//      Decoupled per person, so a miss/late/weekend row on one doesn't affect the
//      other, and an older un-reviewed row still gets picked up.
//   3. Post a founder digest to Slack (once per real run, when new comments post
//      or when there is an escalation).
// ?dry=1 generates everything and returns it as JSON (incl. the Slack preview)
// without posting anything.
//
// Dead-man's switch (severity "broken", the loud lane):
//   - The route crashes -> Slack, because a Vercel cron 500 is silent and the team would
//     go unreviewed forever with nobody knowing.
//   - The coaching call fails for half or more of the team -> Slack, because every failed
//     call used to render as the harmless string "no note", which made a total Anthropic
//     outage look exactly like a calm day. It must never be ambiguous.

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

// A dead Anthropic API used to be invisible: every call returned null, every person
// rendered as the innocuous "no note", and a total outage read exactly like a calm day.
// Every call is now counted here so the caller can tell "nobody needed coaching" apart
// from "coaching could not be written for anybody".
type AiHealth = { attempts: number; failures: number; lastError: string | null };

// Assistant reply addressed to the team member. Returns null on any failure so
// the caller degrades gracefully (no comment posted) and records it in `health`.
async function assistantComment(
  input: {
    name: string;
    hours: string;
    output: number | null;
    clean: boolean;
    winBlocker: string;
    recentOutputs: (number | null)[]; // prior work-days, newest first, excl. today
    prev: PrevContext | null; // their previous scorecard + whether they replied
  },
  health: AiHealth,
): Promise<string | null> {
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

  return callClaude(prompt, 400, health);
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
  health: AiHealth,
): Promise<string | null> {
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
  return callClaude(prompt, 500, health);
}

// Shared raw call to the Anthropic API (opus, no thinking, text-only out). Every exit
// path that produces no text is a FAILURE and is recorded, including a missing API key
// and an empty completion. Callers still get null and degrade gracefully.
async function callClaude(
  prompt: string,
  maxTokens: number,
  health: AiHealth,
): Promise<string | null> {
  health.attempts++;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    health.failures++;
    health.lastError = "ANTHROPIC_API_KEY is not set";
    console.error("[team-eod-digest] ANTHROPIC_API_KEY is not set");
    return null;
  }
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
      const body = await res.text();
      console.error("[team-eod-digest] Claude error:", res.status, body);
      health.failures++;
      health.lastError = `Anthropic returned HTTP ${res.status}: ${snip(body, 160)}`;
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
    if (!text) {
      health.failures++;
      health.lastError = "Anthropic returned an empty completion";
      console.error("[team-eod-digest] Claude returned an empty completion");
      return null;
    }
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[team-eod-digest] Claude fetch failed:", message);
    health.failures++;
    health.lastError = message;
    return null;
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
  coachFailed?: boolean; // we tried to generate a note for them and the AI gave us nothing
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
    const coachHealth: AiHealth = { attempts: 0, failures: 0, lastError: null };
    const weeklyHealth: AiHealth = { attempts: 0, failures: 0, lastError: null };
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

      // Idempotency: has our bot already commented on this row? Checked BEFORE the AI
      // call so an already-reviewed row costs nothing and cannot skew the AI-health math
      // (a failure there is not a person who lost their coaching note).
      let alreadyCommented = false;
      try {
        const existing = await notion.comments.list({ block_id: card.id });
        alreadyCommented = existing.results.some(
          (c) => botId != null && (c.created_by as AnyProps)?.id === botId,
        );
      } catch (err) {
        console.error("[team-eod-digest] comments.list failed:", err);
      }

      // In a real run there is nothing to write on a reviewed row. ?dry=1 still generates
      // the note: previewing it is the whole point of a dry run.
      const needsCoaching = !alreadyCommented || dry;
      const comment = needsCoaching
        ? await assistantComment(
            { name: member.name, hours, output, clean, winBlocker, recentOutputs, prev },
            coachHealth,
          )
        : null;
      // assistantComment makes exactly one Claude call, and callClaude returns null only
      // when that call produced no text, so null here means the AI failed this person.
      const coachFailed = needsCoaching && comment === null;

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
        coachFailed,
        prevDay: prev?.day ?? null,
        prevReplied: prev?.botCommented ? prev.replied : null,
        rowUrl: scorecardRowUrl(card.id),
      });
    }

    // Escalations (objective chronic-pattern flags for Asad). Carry the person's
    // name so the Slack headline can say WHO, never just a count.
    const escalations: { name: string; text: string }[] = [];
    for (const r of results) {
      if (!r.submitted) {
        escalations.push({
          name: r.name,
          text: `${r.name} has not filed an end of day in the last ${LOOKBACK_DAYS} days.`,
        });
        continue;
      }
      if (r.stale) {
        escalations.push({ name: r.name, text: `${r.name} hasn't submitted since ${r.lastDay}.` });
      }
      const recentZeros = (r.recentOutputs ?? []).filter((o) => (o ?? 0) === 0).length;
      const zeros = ((r.output ?? 0) === 0 ? 1 : 0) + recentZeros;
      const windowN = 1 + (r.recentOutputs?.length ?? 0);
      if ((r.output ?? null) === 0 && zeros >= 3) {
        escalations.push({
          name: r.name,
          text: `${r.name} has shipped nothing on ${zeros} of the last ${windowN} days.`,
        });
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
      const text = await weeklyReview(people, weeklyHealth);
      if (text) weekly = { text, range: `${prevMonday} to ${prevFriday}` };
    }

    // Founder digest → Slack #alerts via notify() at severity "human": a person is
    // waiting on Asad (Akmal and Sidra's scorecards need his reply). Never a receipt.
    const flagged = [...new Set(escalations.map((e) => e.name))];

    // Headline names the people and the outcome, so no two days read the same.
    let headline: string;
    if (escalations.length === 1) {
      headline = escalations[0].text.replace(/\.$/, "");
    } else if (escalations.length > 1) {
      headline = `${flagged.join(" and ")} ${
        flagged.length === 1 ? "needs" : "need"
      } chasing on their end of day (${escalations.length} things flagged)`;
    } else {
      headline = `${results
        .map((r) => `${r.name} (output ${r.output ?? "n/a"})`)
        .join(", ")} filed their end of day, feedback is written on their rows`;
    }

    // notify() escapes < and > in details (anti-spoof), so scorecard links go in as
    // BARE urls. Slack still auto-links them; the <url|label> form would be mangled.
    const details: (string | null)[] = [];
    // With exactly one escalation the headline IS that sentence, so a bullet block here
    // would print it twice. Only worth a "Needs attention" list when there are several.
    if (escalations.length > 1) {
      details.push("*Needs attention*");
      for (const e of escalations) details.push(`• ${e.text}`);
    }
    for (const r of results) {
      if (!r.submitted) {
        details.push(
          `*${r.name}*: has not filed an end of day in the last ${LOOKBACK_DAYS} days.`,
        );
        continue;
      }
      const zero = (r.output ?? 0) === 0 ? " (nothing shipped)" : "";
      // "no note" is only innocent when nothing went wrong. A failed AI call says so,
      // otherwise an outage renders identically to a calm day.
      const state = r.posted
        ? "feedback written"
        : r.alreadyCommented
        ? "already reviewed"
        : r.coachFailed
        ? "no feedback, the AI failed on this one"
        : "no feedback";
      details.push(
        `*${r.name}* (${r.lastDay}). Output ${r.output ?? "n/a"}${zero}. ${state}. ${r.rowUrl}`,
      );
      // Curly quotes, not a "> " blockquote: notify() escapes > into &gt;.
      if (r.comment) details.push(`“${snip(r.comment, 260)}”`);
    }
    if (weekly) {
      details.push(`*Week in review* (${weekly.range})`);
      details.push(weekly.text);
    } else if (isMonday && weeklyHealth.failures > 0) {
      // Say it is missing. A silently absent section reads like there was nothing to say.
      details.push("*Week in review* is missing, the AI that writes it failed.");
    }

    const action = escalations.length
      ? `Chase ${flagged.join(" and ")}, then reply on the scorecard row in Notion.`
      : "Read the notes and reply on their scorecard rows if you want to add anything.";
    // notify() validates this as a plain https URL and renders the label itself.
    const link = `https://www.notion.so/${SCORECARDS_DB_ID}`;
    const linkLabel = "Scorecards database";

    // Preview of the body notify() renders, kept for ?dry=1 consumers.
    const slackText = [
      `\u{1F64B} [Team] *${headline}*`,
      ...details.filter(Boolean),
      `→ ${action}`,
      `<${link}|${linkLabel}>`,
    ].join("\n");

    // The AI going down used to be silent: every catch returned null, every person read
    // as "no note", and the digest looked like a quiet day. Half or more of the team
    // losing their note is a BROKEN-lane event. Half, not a strict majority: the roster
    // is two people, so "majority" would mean "both" and let a one-of-two blackout pass.
    const coachFailedNames = results.filter((r) => r.coachFailed).map((r) => r.name);
    const aiDown =
      coachHealth.attempts > 0 && coachHealth.failures * 2 >= coachHealth.attempts;

    let brokenAttempted = false;
    if (!dry && aiDown) {
      const who = coachFailedNames.join(" and ");
      await notify({
        severity: "broken",
        headline: `${who} got no feedback on today's scorecard, the AI that writes it is down`,
        details: [
          `It failed on ${coachHealth.failures} of ${coachHealth.attempts} scorecards, so their rows in Notion are sitting there with nothing written on them.`,
          "This is not a quiet day. Every run from here will go the same way until it recovers.",
        ],
        action: `Write a line on ${who}'s scorecard yourself today so they are not left hanging. If tomorrow's digest says the same thing, tell me.`,
        link,
        linkLabel,
      });
      brokenAttempted = true;
    }

    // Send once per real run. Gating purely on `posted` used to swallow the digest
    // on exactly the worst days: an absent teammate gets no comment, so a "no EOD in
    // 14 days" escalation would post nowhere. Escalations now send on their own.
    let slackAttempted = false;
    if (!dry && (results.some((r) => r.posted) || escalations.length > 0)) {
      await notify({ severity: "human", headline, details, action, link, linkLabel });
      slackAttempted = true;
    }

    return Response.json({
      dry,
      today,
      isMonday,
      escalations: escalations.map((e) => e.text),
      weekly: weekly?.range ?? null,
      slackConfigured: !!(
        process.env.SLACK_ALERT_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL
      ),
      slackAttempted,
      slackText,
      aiDown,
      brokenAttempted,
      coaching: { ...coachHealth, failedFor: coachFailedNames },
      weeklyAi: weeklyHealth,
      results,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[team-eod-digest] Error:", message);
    // A Vercel cron 500 is silent. Without this, the digest can die on a Notion outage, a
    // revoked NOTION_TOKEN or an Anthropic failure and nobody ever finds out: no comment
    // lands in Notion, no Slack message goes anywhere, and the team stays unreviewed every
    // weekday from here on. The broken lane exists for exactly this.
    if (!dry) {
      await notify({
        severity: "broken",
        headline: `The team end of day digest is dead, ${ROSTER.map((m) => m.name).join(
          " and ",
        )} are going unreviewed`,
        details: [
          "It stopped before it could finish, so nobody got feedback on their scorecard and no digest went out.",
          "It will fail the same way every weekday until it is fixed.",
        ],
        action:
          "Reply on their scorecards yourself today so the team is not left waiting, and tell me the digest is down so I can get it running again.",
        link: `https://www.notion.so/${SCORECARDS_DB_ID}`,
        linkLabel: "Scorecards database",
      });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
