// PM-UI 08 setup wizard (`setup-wizard`, sheets/setup-wizard.md): steps 2–4 of a new project for Kavya Rao, Growth lead.
// States: clocks · clocks-changed (Day 0 moved to 24 Nov) · clocks-picker (Day 0 calendar open) · people · preview ·
// creating. A narrow centred page (~900 px): back + "New project", the stepper, the project band, the step's cards and
// Back / Next (a sticky bar above the tab bar on a phone). The live parts are in ./setup-wizard-client.
import type { SetupWizardVM } from "../contract/setup-wizard";
import type { ScreenProps } from "../contract/shared";
import { PmPage } from "../kit";
import { SetupWizardView } from "./setup-wizard-client";

export default function SetupWizard({ vm }: ScreenProps<SetupWizardVM>) {
  return <PmPage width="narrow"><SetupWizardView vm={vm} /></PmPage>;
}
