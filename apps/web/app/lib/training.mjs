// KAZUK-REST slice 7: Learn → Training, the words and small rules the training pages share (pure, unit-tested in
// training.test.mjs). A course has videos (a link or an uploaded clip) and a short quiz; people or whole groups are
// assigned it; a person is done when every video is watched (90 %) and the quiz is passed.

/** The groups a course can be assigned to, as the database names them (training_assignment.target), with plain labels.
 *  `team` is the company's own word for a team (its vocabulary). */
export function groupLabel(kind, target, team = "Team", heads = "Heads") {
  if (kind === "side") return { staff: "All staff", freelancer: "Freelancers", channel_partner: "Partners and dealers", vendor: "Vendors", talent: "Talent", other: "Other people" }[target] ?? target;
  if (kind === "role") return { member: "Members", pod_head: `${team} ${heads.charAt(0).toLowerCase()}${heads.slice(1)}`, hr: "HR", leadership: "Leadership" }[target] ?? target;
  return target ?? "";
}
export const SIDES = ["channel_partner", "staff", "freelancer", "vendor", "talent", "other"];
export const ROLES = ["member", "pod_head", "hr", "leadership"];

/** Where a video's playback has reached, as the share to keep: the last milestone passed (25, 50, 75, 90 or 100 %), or
 *  null when nothing new was passed since `kept`. Sending only milestones keeps the requests few. */
export function milestone(currentTime, duration, kept = 0) {
  if (!(duration > 0) || !(currentTime >= 0)) return null;
  const pct = Math.min(100, Math.floor((100 * currentTime) / duration + 0.5));
  const reached = [100, 90, 75, 50, 25].find((m) => pct >= m);
  return reached && reached > kept ? reached : null;
}

/** One line for a person's standing in a course. */
export function standingLine(s) {
  if (!s) return "Not started";
  if (s.done) return "Done";
  const parts = [];
  if (s.videos) parts.push(`${s.watched} of ${s.videos} videos watched`);
  if (s.questions) parts.push(s.passed ? "quiz passed" : s.tries ? `quiz not passed yet (best ${s.best} %)` : "quiz not taken");
  return parts.length ? parts.join(", ") : "Nothing to do yet";
}

/** The share of a course done, for a progress bar: videos watched count for the videos, a passed quiz for one more step. */
export function standingPercent(s) {
  if (!s) return 0;
  if (s.done) return 100;
  const steps = (s.videos ?? 0) + (s.questions ? 1 : 0);
  if (!steps) return 0;
  return Math.round((100 * ((s.watched ?? 0) + (s.questions && s.passed ? 1 : 0))) / steps);
}

/** How a link is shown: the provider's name for the button. */
export function providerLabel(provider) {
  return { youtube: "YouTube", vimeo: "Vimeo", drive: "Google Drive", upload: "Uploaded video" }[provider] ?? "the video page";
}
