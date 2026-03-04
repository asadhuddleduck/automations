import { notion } from "@/lib/notion";

const DAILY_DB_ID = "2c384fd7-bc4e-81db-9784-e2471a5bca44";

function formatTime(totalSeconds: number): string {
  const totalMinutes = Math.ceil(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} hrs ${minutes} mins`;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  const startDate = yesterday.toISOString().slice(0, 10);
  const endDate = today.toISOString().slice(0, 10);

  // 1. Fetch Toggl time entries for yesterday
  const togglToken = process.env.TOGGL_API_TOKEN;
  const basicAuth = Buffer.from(`${togglToken}:api_token`).toString("base64");

  const togglRes = await fetch(
    `https://api.track.toggl.com/api/v9/me/time_entries?start_date=${startDate}&end_date=${endDate}`,
    { headers: { Authorization: `Basic ${basicAuth}` } }
  );

  if (!togglRes.ok) {
    return Response.json(
      { error: "Toggl API failed", status: togglRes.status },
      { status: 500 }
    );
  }

  const entries = await togglRes.json();

  // 2. Bucket by description
  let workSeconds = 0;
  let gameSeconds = 0;

  for (const entry of entries) {
    if (entry.duration < 0) continue; // timer still running
    const desc = (entry.description || "").toLowerCase();
    if (desc === "gaming") gameSeconds += entry.duration;
    else if (desc === "tracked work") workSeconds += entry.duration;
  }

  const trackedWork = formatTime(workSeconds);
  const gameTime = formatTime(gameSeconds);

  // 3. Find yesterday's Daily page in Notion
  const queryRes = await notion.dataSources.query({
    data_source_id: DAILY_DB_ID,
    filter: {
      property: "Date",
      date: { equals: startDate },
    },
    page_size: 1,
  });

  if (queryRes.results.length === 0) {
    return Response.json(
      { error: "No Daily page found for " + startDate },
      { status: 404 }
    );
  }

  const pageId = queryRes.results[0].id;

  // 4. Update the page
  await notion.pages.update({
    page_id: pageId,
    properties: {
      "Tracked Work": {
        rich_text: [{ text: { content: trackedWork } }],
      },
      "Game Time": {
        rich_text: [{ text: { content: gameTime } }],
      },
    },
  });

  return Response.json({
    success: true,
    date: startDate,
    trackedWork,
    gameTime,
  });
}
