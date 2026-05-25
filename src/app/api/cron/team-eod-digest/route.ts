import { notion } from "@/lib/notion";

// Rebuild of the team-EOD digest writer that died in the 10 May 2026 Notion AI
// feature downgrade (same incident that forced the notion-view.js shim). This
// runs in code instead of relying on a Notion-native AI automation.
//
// Flow each weekday morning:
//   1. Find today's "Review yesterday's team EOD reports" Actions page (created
//      by the midnight recurring-tasks cron).
//   2. Find the latest prior work-day that has scorecards (skips weekends).
//   3. For each roster member, build a Hours/Output/Clean line + Claude-written
//      coaching bullets from their Win+blocker. Missing member -> follow-up note.
//   4. Append the digest blocks to the task body (idempotent — skips if already
//      filled).

const ACTIONS_DB_ID = "2c384fd7-bc4e-81a1-b469-e33afbf19157";
const SCORECARDS_DB_ID = "9dfdc9d7735941088a66b4c8978a54ca";
const SCORECARDS_URL = "https://www.notion.so/9dfdc9d7735941088a66b4c8978a54ca";
const REVIEW_TASK_TITLE = "Review yesterday's team EOD reports";
const LOOKBACK_DAYS = 4; // covers a weekend + a bank holiday

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

async function claudeBullets(input: {
  name: string;
  hours: string;
  output: number | null;
  clean: boolean;
  winBlocker: string;
}): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  const prompt = `You are coaching Asad (the founder) on his team member's end-of-day report. Write 2-3 short, specific coaching bullets addressed to Asad about ${input.name}'s day. Reference their actual numbers and their win/blocker. Be direct and useful — flag anything worth Asad acting on (low output, repeated blockers, wins to reinforce). No preamble, no headers. Return ONLY the bullets, one per line, no bullet characters.

${input.name} — Hours: ${input.hours || "n/a"} | Output: ${input.output ?? "n/a"} | All clean: ${input.clean ? "Yes" : "No"}
Win + blocker: ${input.winBlocker || "(none submitted)"}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error("[team-eod-digest] Claude error:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    return text
      .split("\n")
      .map((l) => l.replace(/^[\s\-*•\d.]+/, "").trim())
      .filter(Boolean);
  } catch (err) {
    console.error("[team-eod-digest] Claude fetch failed:", err);
    return [];
  }
}

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
const numbered = (text: string): any => ({
  object: "block",
  type: "numbered_list_item",
  numbered_list_item: { rich_text: [{ type: "text", text: { content: text } }] },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const link = (label: string, url: string): any => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content: label, link: { url } } }] },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const divider = (): any => ({ object: "block", type: "divider", divider: {} });

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const today = londonDate(0);

    // 1. Find today's review task.
    const tasks = await notion.databases.query({
      database_id: ACTIONS_DB_ID,
      filter: {
        and: [
          { property: "Do date", date: { equals: today } },
          { property: "Task", title: { equals: REVIEW_TASK_TITLE } },
        ],
      },
    });
    if (tasks.results.length === 0) {
      return Response.json({ skipped: "no review task for today", date: today });
    }
    const taskPage = tasks.results[0];

    // Idempotency: skip if the body already has blocks.
    const existing = await notion.blocks.children.list({ block_id: taskPage.id, page_size: 1 });
    if (existing.results.length > 0) {
      return Response.json({ skipped: "body already populated", taskId: taskPage.id });
    }

    // 2. Pull recent scorecards and pick the latest prior work-day with data.
    const cutoff = londonDate(-LOOKBACK_DAYS);
    const scorecards = await notion.databases.query({
      database_id: SCORECARDS_DB_ID,
      page_size: 50,
    });
    type Card = { person: string | null; workDay: string; props: AnyProps; id: string };
    const cards: Card[] = scorecards.results
      .map((r) => {
        const props = ("properties" in r ? r.properties : {}) as AnyProps;
        const people = props.Person?.people ?? [];
        return {
          person: people[0]?.id ?? null,
          workDay: scorecardWorkDay(r as AnyProps),
          props,
          id: r.id,
        };
      })
      .filter((c) => c.workDay < today && c.workDay >= cutoff);

    if (cards.length === 0) {
      return Response.json({ skipped: "no scorecards in lookback window", today, cutoff });
    }
    const targetDay = cards.map((c) => c.workDay).sort().reverse()[0];

    // 3. Build the digest per roster member.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = [];
    for (let i = 0; i < ROSTER.length; i++) {
      const member = ROSTER[i];
      const card = cards.find((c) => c.person === member.id && c.workDay === targetDay);
      if (i > 0) blocks.push(divider());
      blocks.push(h2(`${member.name} — ${targetDay}`));

      if (!card) {
        blocks.push(para("⚠️ No EOD submitted. Follow up with them."));
        continue;
      }
      const hours = richText(card.props.Hours);
      const output = card.props.Output?.number ?? null;
      const clean = card.props["All clean?"]?.checkbox ?? false;
      const winBlocker = richText(card.props["Win + blocker"]);

      blocks.push(para(`Hours: ${hours || "n/a"} | Output: ${output ?? "n/a"} | Clean: ${clean ? "Yes" : "No"}`));
      const bullets = await claudeBullets({ name: member.name, hours, output, clean, winBlocker });
      if (bullets.length > 0) {
        bullets.forEach((b) => blocks.push(numbered(b)));
      } else if (winBlocker) {
        blocks.push(para(winBlocker));
      }
      blocks.push(link("→ Open scorecard", SCORECARDS_URL));
    }

    // 4. Write to the task body.
    await notion.blocks.children.append({ block_id: taskPage.id, children: blocks });

    return Response.json({
      success: true,
      taskId: taskPage.id,
      targetDay,
      members: ROSTER.length,
      blocksWritten: blocks.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[team-eod-digest] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
