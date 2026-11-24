// PM-UI: the view model of the kit gallery (screens/kit.tsx), the reference screen. Not served by the API.
import type { Clock, ClockLineVM, Health, IsoDate, LateFlag, Person, Phase, ProjectRef, Round, StepRow, Viewer } from "./shared";

export type KitVM = {
  today: IsoDate;
  viewer: Viewer;
  agency: string;
  projects: ProjectRef[];
  /** One of each health, with canon reasons. */ healths: Health[];
  phases: Phase[];
  /** The same plan with the current phase late. */ phasesLate: Phase[];
  clocks: Clock[];
  /** Every clock-line state, labelled. */ clockLines: { label: string; line: ClockLineVM }[];
  people: Person[];
  /** One step per status (and late, blocked, skipped). */ steps: StepRow[];
  lates: LateFlag[];
  rounds: Round[];
  nextStep: StepRow;
  /** A project card's next step (owner, due). */ cardNext: StepRow;
  /** Health shown on the sample project card. */ cardHealth: Health;
  /** Draw the sheet open over the page (overlay) instead of inline. */ sheetOpen: boolean;
  /** Wrap the gallery in the client-facing bare page. */ bare: boolean;
};
