// PULSE-HQ: Offer Studio's guided steps (Hormozi's grand slam offer), each with a hint, an example and a check.
import type { Offer } from "./model";

export type StepKey = "customer" | "problems" | "solutions" | "delivery" | "tiers" | "bonuses" | "guarantee" | "scarcity" | "naming" | "price" | "value" | "positioning";
export const STEPS: readonly { key: StepKey; short: string; title: string; hint: string; example?: string; check: string }[] = [
  { key: "customer", short: "Customer", title: "Customer and dream outcome",
    hint: "Who exactly is this for, and what does their life look like once it works? Write it in their words.",
    example: "Founder-led agencies of 15 to 80 people running delivery on WhatsApp and sheets. Dream: every deliverable on time and the founder stops chasing.",
    check: "Describe the customer and their dream outcome in a sentence each." },
  { key: "problems", short: "Problems", title: "The problems in the way",
    hint: "List every obstacle between them and the dream: what slips, what costs time, what they doubt. Each one becomes a solution.",
    example: "Deadlines slip because nobody owns the next step · Client work is scattered across WhatsApp groups · Only the founder knows how things are done.",
    check: "List at least three problems." },
  { key: "solutions", short: "Solutions", title: "A solution for each, from Pulse",
    hint: "For every problem, say how it goes away and pick the Pulse features that do it. This is what makes the offer believable.",
    example: "Deadlines slip → every deliverable is a task with an owner, a due date and a reviewer (Tasks in every view, Finish and review).",
    check: "Give every problem a solution and at least one Pulse feature." },
  { key: "delivery", short: "Delivery", title: "How it is delivered",
    hint: "The vehicles: done for you, done with you, software, templates, calls. More done-for-you means less effort for them.",
    example: "Done-for-you setup in 30 days · a weekly launch call · Pulse on web, phone and desktop · process templates.",
    check: "Add at least two delivery vehicles." },
  { key: "tiers", short: "Packages", title: "Packages and tiers",
    hint: "Group the features into tiers people can choose between. Start from the features your solutions use.",
    check: "Add a tier with features in it." },
  { key: "bonuses", short: "Bonuses", title: "Bonuses",
    hint: "Each bonus answers one objection or removes one more piece of effort. Give each a value they believe.",
    example: "Done-for-you SOP import (worth ₹75,000): nobody starts from a blank page.",
    check: "Add at least one bonus with a value." },
  { key: "guarantee", short: "Guarantee", title: "Guarantee",
    hint: "Take the risk off them. Conditional guarantees tied to the outcome are the strongest.",
    example: "If by day 30 you cannot see every live delivery, its owner and due date in Pulse, month two is free.",
    check: "Write a guarantee." },
  { key: "scarcity", short: "Scarcity", title: "Scarcity and urgency",
    hint: "Give a true reason to decide now: a real capacity limit, a deadline or a price that ends.",
    check: "Add a scarcity or an urgency." },
  { key: "naming", short: "Name", title: "Name it (MAGIC)",
    hint: "Magnet, Avatar, Goal, Interval, Container. Pick from the combinations or write your own, plus a one-line tagline.",
    example: "Agency Autopilot: on-time delivery in 30 days, without the founder chasing.",
    check: "Give the offer a real name and a tagline." },
  { key: "price", short: "Price", title: "Price and anchors",
    hint: "Anchor against what the problem costs today, then show the price. Set a price on each tier.",
    example: "An operations manager to chase delivery: ₹1,20,000 a month. Agency Autopilot: ₹59,999 a month.",
    check: "Set a price and at least one anchor." },
  { key: "value", short: "Value", title: "Check the value equation",
    hint: "Dream outcome × perceived likelihood ÷ (time delay × effort). Raise the top, shrink the bottom; 6 or more is strong.",
    check: "Aim for a value score of 3 or more." },
  { key: "positioning", short: "Positioning", title: "Positioning and brand",
    hint: "For [who] who [pain], [name] is the [category] that [result]. Unlike [alternative], it [difference].",
    example: "For founder-led agencies drowning in WhatsApp follow-ups, Agency Autopilot is the one app where client work, people and money run on their own.",
    check: "Write the positioning statement." },
];

const len = (s: string | undefined, n: number) => (s ?? "").trim().length >= n;

export function stepDone(key: StepKey, o: Offer): boolean {
  const problems = o.problems ?? [];
  switch (key) {
    case "customer": return len(o.icp, 20) && len(o.dreamOutcome, 20);
    case "problems": return problems.filter((p) => len(p.problem, 5)).length >= 3;
    case "solutions": return problems.length > 0 && problems.every((p) => len(p.solution, 5) && p.features.length > 0);
    case "delivery": return (o.delivery ?? []).filter((d) => len(d, 3)).length >= 2;
    case "tiers": return o.tiers.some((t) => t.features.length > 0);
    case "bonuses": return o.bonuses.some((b) => len(b.name, 3) && b.value > 0);
    case "guarantee": return len(o.guarantee, 20);
    case "scarcity": return len(o.scarcity, 10) || len(o.urgency, 10);
    case "naming": return len(o.name, 3) && !/^untitled/i.test(o.name) && len(o.naming?.tagline, 10);
    case "price": return (o.price !== null || o.tiers.some((t) => t.price !== null)) && o.anchors.some((a) => len(a.label, 3) && a.amount > 0);
    case "value": return (o.dream * o.likelihood) / Math.max(1, o.time * o.effort) >= 3;
    case "positioning": return len(o.positioning, 30);
  }
}
export const stepsDone = (o: Offer) => STEPS.filter((s) => stepDone(s.key, o)).length;
