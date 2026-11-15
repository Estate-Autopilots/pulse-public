"""Attribution resolver v0 (02 §4.3, 03 §9.4): who made a delivered version.

posterior_odds(c) = prior_odds(c) x product over signal groups of the group's largest likelihood ratio
P(c) = posterior_odds(c) / (1 + sum of all candidates' odds)        ("nobody in the set" keeps prior mass 1)

- prior odds: the task assignee 1.0, every other candidate 0.1;
- one vote per group (signals from the same device and session are correlated); a missing signal has ratio 1;
- a declaration by the person (attribution.confirmed) overrides; "not mine" (attribution.rejected) removes them;
- declared leave that day multiplies by 0.01;
- decision: P >= 0.95 -> credited automatically (method ``evidence``); otherwise ``unresolved`` with the top
  candidate kept for the private "was this yours?" question (0.60-0.95) or the coordinator queue (< 0.60).
Pure function: the work-graph projector gathers the evidence from the log and calls ``decide``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

VERSION = "delivery-attribution/v1"
LIKELIHOOD = {            # starting values, re-estimated from pilot ground truth (04 M0)
    "hash": 1000.0,       # render on the candidate's device with the same MD5 as the Drive file (export fingerprint)
    "export": 50.0,       # app export with the same file name or CID on the candidate's device, <= 12 h before upload
    "uploader": 20.0,     # uploaded by the candidate's own individual account (evidence, not proof)
    "folder_owner": 100.0,  # owner of the deliverables folder
    "cid_owner": 10.0,    # the CID belongs to an asset whose task is assigned to the candidate
    "project_work": 5.0,  # recent work on the project on the candidate's device (group: work delta, chain match)
}
PRIOR_ASSIGNEE = 1.0
PRIOR_OTHER = 0.1
LEAVE = 0.01
AUTO = 0.95
ASK = 0.60


@dataclass(frozen=True)
class Signal:
    person: uuid.UUID
    group: str
    ratio: float


@dataclass
class Decision:
    person: uuid.UUID | None
    probability: float
    method: str                                   # evidence | declared | unresolved
    evidence: list[dict] = field(default_factory=list)

    @property
    def credited(self) -> bool:
        return self.method in ("evidence", "declared")

    @property
    def ask_person(self) -> bool:
        return self.method == "unresolved" and self.person is not None and self.probability >= ASK


def decide(candidates: set[uuid.UUID], signals: list[Signal], *, assignee: uuid.UUID | None = None,
           declared: uuid.UUID | None = None, rejected: set[uuid.UUID] | None = None,
           on_leave: set[uuid.UUID] | None = None, account_map_person: uuid.UUID | None = None,
           shared_account: bool = False) -> Decision:
    rejected = rejected or set()
    on_leave = on_leave or set()
    if declared is not None and declared not in rejected:
        return Decision(declared, 1.0, "declared", [{"group": "declared", "person": str(declared),
                                                       "how": "confirmation"}])
    pool = (set(candidates) | {s.person for s in signals} | ({assignee} if assignee else set())
            | ({account_map_person} if account_map_person else set())) - rejected
    if not pool:
        return Decision(None, 0.0, "unresolved", ([{"group": "shared_account", "how": "shared"}]
                                                     if shared_account else []))

    active_signals = [signal for signal in signals if signal.person in pool]
    evidence = []
    for signal in active_signals:
        item = {"group": signal.group, "ratio": signal.ratio, "person": str(signal.person)}
        if signal.group in ("hash", "export"):
            item["how"] = "fingerprint"
        elif signal.group == "folder_owner":
            item["how"] = "folder owner"
        evidence.append(item)

    if account_map_person and not shared_account and account_map_person not in rejected:
        return Decision(account_map_person, 1.0, "evidence", evidence + [
            {"group": "account_map", "person": str(account_map_person), "how": "account map"}])

    if shared_account:
        fingerprints = {signal.person for signal in active_signals if signal.group in ("hash", "export")}
        folder_owners = {signal.person for signal in active_signals if signal.group == "folder_owner"}
        if ((fingerprints and folder_owners and fingerprints != folder_owners)
                or len(fingerprints) > 1 or len(folder_owners) > 1):
            return Decision(None, 0.0, "unresolved", evidence + [
                {"group": "shared_account", "how": "shared", "reason": "conflicting_delivery_evidence"}])
        if fingerprints:
            person = next(iter(fingerprints))
            return Decision(person, 1.0, "evidence", evidence + [
                {"group": "fingerprint", "person": str(person), "how": "fingerprint"}])
        if folder_owners:
            person = next(iter(folder_owners))
            return Decision(person, 1.0, "evidence", evidence + [
                {"group": "folder_owner", "person": str(person), "how": "folder owner"}])
    best: dict[tuple[uuid.UUID, str], float] = {}
    for s in active_signals:
        if s.person in pool:
            key = (s.person, s.group)
            best[key] = max(best.get(key, 1.0), s.ratio)
    odds: dict[uuid.UUID, float] = {}
    for c in sorted(pool):
        o = PRIOR_ASSIGNEE if c == assignee else PRIOR_OTHER
        for (person, _group), ratio in best.items():
            if person == c:
                o *= ratio
        if c in on_leave:
            o *= LEAVE
        odds[c] = o
    total = 1.0 + sum(odds.values())
    top = max(sorted(odds), key=lambda c: odds[c])
    p = odds[top] / total
    evidence = []
    for (person, group), ratio in sorted(best.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        item = {"group": group, "ratio": ratio, "person": str(person)}
        if group in ("hash", "export"):
            item["how"] = "fingerprint"
        elif group == "folder_owner":
            item["how"] = "folder owner"
        evidence.append(item)
    if shared_account:
        evidence.append({"group": "shared_account", "how": "shared"})
    if top == assignee:
        evidence.append({"group": "assignee_prior", "person": str(top)})
    method = "evidence" if p >= AUTO and not shared_account else "unresolved"
    return Decision(top, round(p, 3), method, evidence)
