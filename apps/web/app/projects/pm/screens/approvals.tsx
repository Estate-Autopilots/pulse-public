// PM-UI: Approvals (/approvals), SPEC §5.6. Two tabs (Team review, Client approval); phone = one column of cards and a
// detail sheet; from 600 px = list + detail pane. Preview: /projects/pm/preview/approvals?state=default|detail|
// request-changes|changes-requested|client-tab|empty. Signed in: Kavya Rao (the named team reviewer).
import type { ApprovalsVM } from "../contract/approvals";
import type { ScreenProps } from "../contract/shared";
import { PmPage } from "../kit";
import ApprovalsClient from "./approvals-client";

export default function Approvals({ vm }: ScreenProps<ApprovalsVM>) {
  return <PmPage><ApprovalsClient vm={vm} /></PmPage>;
}
