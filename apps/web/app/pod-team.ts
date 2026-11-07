import { lower, NEUTRAL_VOCABULARY } from "./lib/words.mjs";
type Vocabulary = typeof NEUTRAL_VOCABULARY;
/** The two things Pulse keeps apart everywhere: the unit that serves clients (the company's own word for it: "Team" by
 *  default, EA's "Pod") and a function (Creative, Sales). DE-EA: both read the company's vocabulary; when the unit is
 *  called "Team", a function is a "Department" so the two never share a name. */
export const functionWord = (w: Pick<Vocabulary, "team">) => w.team.trim().toLowerCase() === "team" ? "Department" : "Team";
export function podTeam(w: Vocabulary = NEUTRAL_VOCABULARY) {
  const unit = lower(w.team), fn = lower(functionWord(w));
  return {
    pod: `A ${unit} is a delivery unit: the people who serve a set of ${lower(w.clients)} together.`,
    team: `A ${fn} is a function, such as Creative, Performance or Sales. A person has one ${unit} and one ${fn}.`,
  };
}
/** The neutral wording, for places that do not read the company's words yet. */
export const POD_TEAM = podTeam();
