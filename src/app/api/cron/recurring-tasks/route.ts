import { notion } from "@/lib/notion";
import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints.d";

const RECURRING_TASKS_DB_ID = "2c384fd7-bc4e-8111-9c6b-f0912739341c";
const ACTIONS_DB_ID = "2c384fd7-bc4e-81a1-b469-e33afbf19157";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    // 1. Get all active recurring task templates
    const templates = await notion.databases.query({
      database_id: RECURRING_TASKS_DB_ID,
      filter: {
        property: "Active?",
        checkbox: { equals: true },
      },
    });

    let created = 0;

    // 2. Create an Actions page for each template
    for (const template of templates.results) {
      if (!("properties" in template)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = template.properties as Record<string, any>;

      // Extract title
      const titleArr = props["Task"]?.title;
      const title =
        Array.isArray(titleArr) && titleArr.length > 0
          ? titleArr[0].plain_text
          : "Untitled Task";

      // Extract driver (people)
      const peopleArr = props["Driver"]?.people;
      const driverIds =
        Array.isArray(peopleArr) && peopleArr.length > 0
          ? peopleArr.map((p: { id: string }) => ({ object: "user" as const, id: p.id }))
          : [];

      // Extract project relation (🏌🏽 Projects)
      const relationArr = props["\u{1F3CC}\u{1F3FD} Projects"]?.relation;
      const projectIds =
        Array.isArray(relationArr) && relationArr.length > 0
          ? relationArr.map((r: { id: string }) => ({ id: r.id }))
          : [];

      // Extract outcome (rich_text)
      const richTextArr = props["Outcome"]?.rich_text;
      const outcome =
        Array.isArray(richTextArr) && richTextArr.length > 0
          ? richTextArr[0].plain_text
          : "";

      // Build properties for new Actions page
      const newPageProps: CreatePageParameters["properties"] = {
        title: {
          title: [{ text: { content: title } }],
        },
        "Do date": {
          date: { start: today },
        },
      };

      if (driverIds.length > 0) {
        newPageProps["Driver"] = { people: driverIds };
      }

      if (projectIds.length > 0) {
        newPageProps["Client/Projects"] = { relation: projectIds };
      }

      if (outcome) {
        newPageProps["Outcome"] = {
          rich_text: [{ text: { content: outcome } }],
        };
      }

      await notion.pages.create({
        parent: { database_id: ACTIONS_DB_ID },
        properties: newPageProps,
      });

      created++;
    }

    return Response.json({
      success: true,
      date: today,
      tasksCreated: created,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[recurring-tasks] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
