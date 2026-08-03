// One Slack sender for this repo. Severity picks the channel: anything that
// needs Asad goes to #alerts (loud), receipts go to #firehose (muted).
// SLACK_WEBHOOK_URL is the pre-migration fallback so nothing goes dark mid-cutover.

export type Severity = "money" | "lead" | "human" | "broken" | "fyi";

const EMOJI: Record<Severity, string> = {
  money: "\u{1F4B7}",
  lead: "\u{1F3AF}",
  human: "\u{1F64B}",
  broken: "\u{1F534}",
  fyi: "\u26AA",
};

const PRODUCT = "Team";

// Slack parses mrkdwn in `text`: literal < > enable <!channel> pings and
// <url|label> spoofed links. Escape every interpolated value.
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// `link` used to be the one value that went into the message unescaped, so a caller
// passing a user-derived URL could smuggle mrkdwn (a spoofed <url|label>, an <!channel>
// ping) straight into the channel. Only a plain https URL gets through now. The label,
// if any, is rendered here and escaped, never handed to us pre-wrapped in < >.
function safeLink(link: string, label?: string): string | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  // URL parsing percent-encodes < and > everywhere, but leaves | and backticks in the
  // path, and Slack reads both. Anything with them left in is not a link we will print.
  if (/[<>|`\s]/.test(u.href)) return null;
  const href = esc(u.href); // & -> &amp;, per Slack's escaping rules
  return label ? "<" + href + "|" + esc(label) + ">" : href;
}

export async function notify(a: {
  severity: Severity;
  headline: string;
  details?: (string | null | undefined)[];
  action?: string; // omit => "Nothing to do."
  link?: string; // plain https URL; anything else is dropped
  linkLabel?: string; // optional anchor text, rendered as <url|label>
}): Promise<void> {
  // ONE channel, #alerts (3 Aug 2026). The old `fyi` split sent receipts to a
  // muted #firehose that nobody ever opened.
  const routed = process.env.SLACK_ALERT_WEBHOOK_URL;
  const url = routed?.trim() || process.env.SLACK_WEBHOOK_URL?.trim();
  if (!url) return;

  const lines = [EMOJI[a.severity] + " [" + PRODUCT + "] *" + esc(a.headline) + "*"];
  for (const d of a.details ?? []) if (d) lines.push(esc(d));
  lines.push(a.action ? "\u2192 " + esc(a.action) : "\u2192 Nothing to do.");
  if (a.link) {
    const rendered = safeLink(a.link, a.linkLabel);
    if (rendered) lines.push(rendered);
    else console.error("[notify] dropped a link that is not a plain https URL");
  }

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[notify] failed:", err instanceof Error ? err.message : String(err));
  }
}
