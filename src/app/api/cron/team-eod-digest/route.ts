import { notion } from "@/lib/notion";

// Team-EOD accountability assistant.
//
// Replaces the claude.ai cloud routine "⚡ Daily Team EOD Review" (silenced
// 7 Jul 2026) AND corrects the 25 May code rebuild, which wrongly wrote
// founder-facing coaching to Asad. This version is TEAM-FACING: each weekday
// morning it reviews yesterday's scorecards and, for each team member, posts a
// comment ON THEIR scorecard row (@mentioning them) in Asad's assistant voice —
// praising only substantiated wins, and calling out skipped/faked blockers and
// zero-output days against the standard written into the scorecard's own field
// descriptions (Hormozi EOD: the blocker is the ONE binding constraint, never
// "none"). It also writes a compliance roll-up into Asad's "Review yesterday's
// team EOD reports" task so he can audit what was posted.
//
// Flow (GET, weekday cron 30 6 * * 1-5):
//   1. Pull recent scorecards; pick the latest prior work-day with data.
//   2. For each roster member: take their LATEST submission for that day, build
//      a trend line, ask Claude for a reply addressed to them.
//   3. Auto-post that reply as a comment on their scorecard row (idempotent:
//      skips if our bot already commented on the row).
//   4. Append a compliance roll-up to Asad's review task (idempotent: skips if
//      the body already has blocks).
// ?dry=1 generates everything and returns it as JSON without posting/appending.

const ACTIONS_DB_ID = "2c384fd7-bc4e-81a1-b469-e33afbf19157";
const SCORECARDS_DB_ID = "9dfdc9d7735941088a66b4c8978a54ca";
const SCORECARDS_URL = "https://www.notion.so/9dfdc9d7735941088a66b4c8978a54ca";
const REVIEW_TASK_TITLE = "Review yesterday's team EOD reports";
const LOOKBACK_DAYS = 14; // 2 weeks of history for trend context

// Expected team roster. Missing member on the target day -> "No EOD submitted".
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

// The work-day a scorecard reports for lives in its title as a leading ISO
// datetime; fall back to created_time if the title isn't parseable.
function scorecardWorkDay(page: AnyProps): string {
  const title = titleText(page.properties?.Name);
  const m = title.match(/\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  return (page.created_time as string).slice(0, 10);
}

// Assistant reply addressed to the team member. Returns null on any failure so
// the caller degrades gracefully (roll-up still writes, no comment posted).
type PrevContext = {
  day: string;
  output: number | null;
  winBlocker: string;
  botCommented: boolean; // did we leave a note on that row?
  replied: boolean; // did THIS member reply after our note?
  replyText: string;
};

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
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error("[team-eod-digest] Claude error:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    // Join text blocks (robust even if a thinking block ever appears first).
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

// --- block builders (founder roll-up) ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h2 = (text: string): any => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const para = (text: string): any => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const link = (label: string, url: string): any => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content: label, link: { url } } }] },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const divider = (): any => ({ object: "block", type: "divider", divider: {} });

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
  hours?: string;
  output?: number | null;
  clean?: boolean;
  winBlocker?: string;
  comment?: string | null;
  posted?: boolean;
  alreadyCommented?: boolean;
  prevDay?: string | null;
  prevReplied?: boolean | null; // null = no prior note of ours to reply to
};

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dry = new URL(request.url).searchParams.get("dry") === "1";

  try {
    const today = londonDate(0);

    // Founder roll-up target (may be absent on weekends / if not yet created).
    const tasks = await notion.databases.query({
      database_id: ACTIONS_DB_ID,
      filter: {
        and: [
          { property: "Do date", date: { equals: today } },
          { property: "Task", title: { equals: REVIEW_TASK_TITLE } },
        ],
      },
    });
    const taskPage = tasks.results[0] ?? null;

    // 1. Pull recent scorecards, pick the latest prior work-day with data.
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

    if (cards.length === 0) {
      return Response.json({ skipped: "no scorecards in lookback window", today, cutoff });
    }
    const targetDay = cards.map((c) => c.workDay).sort().reverse()[0];

    // Our integration's bot user id — used for comment idempotency.
    let botId: string | null = null;
    try {
      botId = ((await notion.users.me({})) as AnyProps).id ?? null;
    } catch (err) {
      console.error("[team-eod-digest] users.me failed:", err);
    }

    // 2. + 3. Per member: pick latest submission, coach, post comment.
    const results: MemberResult[] = [];
    for (const member of ROSTER) {
      // Latest submission for the target day (fixes duplicate same-day rows).
      const card =
        cards
          .filter((c) => c.person === member.id && c.workDay === targetDay)
          .sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1))[0] ?? null;

      if (!card) {
        results.push({ name: member.name, submitted: false });
        continue;
      }

      const hours = richText(card.props.Hours);
      const output = card.props.Output?.number ?? null;
      const clean = card.props["All clean?"]?.checkbox ?? false;
      const winBlocker = richText(card.props["Win + blocker"]);

      // Trend: last 5 prior work-days for this member (latest row per day).
      const byDay = new Map<string, Card>();
      for (const c of cards) {
        if (c.person !== member.id || c.workDay >= targetDay) continue;
        const cur = byDay.get(c.workDay);
        if (!cur || c.createdTime > cur.createdTime) byDay.set(c.workDay, c);
      }
      const priorDaysDesc = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const recentOutputs = priorDaysDesc
        .slice(0, 5)
        .map(([, c]) => c.props.Output?.number ?? null);

      // Previous scorecard (their most recent prior submission) + did they reply
      // to the note we left on it? Gives the daily nudge continuity/memory.
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
            ((a.created_time as string) < (b.created_time as string) ? -1 : 1),
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
        hours,
        output,
        clean,
        winBlocker,
        comment,
        posted,
        alreadyCommented,
        prevDay: prev?.day ?? null,
        prevReplied: prev?.botCommented ? prev.replied : null,
      });
    }

    // 4. Founder roll-up (compliance scan + audit of what was posted).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = [];
    blocks.push(h2(`Team EOD — ${targetDay}`));
    blocks.push(
      para(
        "Submitted: " +
          results
            .map((r) => (r.submitted ? `✅ ${r.name}` : `⚠️ ${r.name} — NO REPORT`))
            .join("   ·   "),
      ),
    );
    for (const r of results) {
      blocks.push(divider());
      blocks.push(h2(r.name));
      if (!r.submitted) {
        blocks.push(para(`⚠️ No EOD submitted for ${targetDay}. Chase them.`));
        continue;
      }
      blocks.push(
        para(
          `Hours: ${r.hours || "n/a"} | Output: ${r.output ?? "n/a"} | Clean: ${r.clean ? "Yes" : "No"}`,
        ),
      );
      blocks.push(
        para(
          `${(r.output ?? 0) > 0 ? "Output shipped ✅" : "Output 0 ⚠️"} · All clean: ${
            r.clean ? "Yes" : "No"
          }`,
        ),
      );
      if (r.prevReplied != null) {
        blocks.push(
          para(`Replied to ${r.prevDay ?? "last"} note: ${r.prevReplied ? "Yes ✅" : "No ⚠️"}`),
        );
      }
      if (r.comment) {
        const status = r.posted
          ? " (posted)"
          : r.alreadyCommented
          ? " (already posted)"
          : dry
          ? " (dry-run — not posted)"
          : " (not posted)";
        blocks.push(para(`Assistant → ${r.name}${status}:`));
        blocks.push(para(r.comment));
      }
      blocks.push(link("→ Open scorecard", SCORECARDS_URL));
    }

    let bodyWritten = false;
    if (!dry && taskPage) {
      const existing = await notion.blocks.children.list({ block_id: taskPage.id, page_size: 1 });
      if (existing.results.length === 0) {
        await notion.blocks.children.append({ block_id: taskPage.id, children: blocks });
        bodyWritten = true;
      }
    }

    return Response.json({
      dry,
      targetDay,
      taskId: taskPage?.id ?? null,
      bodyWritten,
      results,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[team-eod-digest] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
