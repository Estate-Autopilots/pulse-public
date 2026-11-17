"""CHAT-VOICE-FIX part 2 (migration 2135): a voice note's transcript is shown only when the server is sure of it; a note
it is not sure of says so (with an English gist) and an AI employee is told it was not clear instead of reading the
guess; search finds notes by their clear words or gist, only in conversations the viewer reads; older transcripts are
made again in place without waking anyone. Synthetic notes and words only; the engines are stood in for (their own
bake-off is in the lane report)."""
import importlib.util
import json
import uuid
from pathlib import Path

from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

ROOT = Path(__file__).resolve().parents[2]


def _worker_module():
    spec = importlib.util.spec_from_file_location("voice_transcribe", ROOT / "tools/voice-transcribe.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _note(api, w, group):
    fid = one(api, w, w.editor, "select pulse.chat_file_add(%s,'Voice message.webm','audio/webm',%s) id", (group, b"\x1aE\xdf\xa3synthetic"))["id"]
    note = {"id": str(fid), "name": "Voice message.webm", "mime": "audio/webm", "voice": {"seconds": 5, "peaks": [20 + (i * 37) % 80 for i in range(48)]}}
    return fid, one(api, w, w.editor, "select pulse.chat_send(%s,'',null,%s,%s,null) id", (group, json.dumps([note]), uuid.uuid4()))["id"]


def _heard(worker, w, mid, fid, body, clear, gist=None, engine="indicwhisper-mr+indicconformer-mr"):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse_priv.chat_voice_transcript(org_id,message_id,file_id,requested_by,state,body,clear,confidence,gist,language,engine,done_at)
            values(%s,%s,%s,%s,'done',%s,%s,%s,%s,'mr',%s,now()) on conflict (message_id,file_id) do update set state='done',body=excluded.body,clear=excluded.clear,
            confidence=excluded.confidence,gist=excluded.gist,engine=excluded.engine""", (w.org, mid, fid, w.editor, body, clear, 0.9 if clear else 0.4, gist, engine))


def test_unclear_words_are_hidden_searched_by_gist_and_never_read_as_words(api, worker, owner, team):  # noqa: F811
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Heard crew',%s) id", ([w.editor2],))["id"]
    f1, clear = _note(api, w, group)
    f2, unclear = _note(api, w, group)
    _heard(worker, w, clear, f1, "उद्या सकाळी अकरा वाजता शूट आहे", True)
    _heard(worker, w, unclear, f2, "garbled guess lakeview", False, gist="Send the proposal to the client today")
    heard = {r["message_id"]: r for r in as_(api, w, w.editor2, "select * from pulse.chat_voice_heard(%s)", (group,))}
    assert heard[clear]["clear"] is True and heard[unclear]["clear"] is False and heard[unclear]["gist"].startswith("Send the proposal")
    # Search: the clear words and the gist find their notes; the hidden guess finds nothing; an outsider finds nothing.
    find = lambda who, q, ch=None: [r["message_id"] for r in as_(api, w, who, "select * from pulse.chat_voice_search(%s,%s,60)", (q, ch))]
    assert find(w.editor2, "अकरा") == [clear] and find(w.editor2, "अकरा", group) == [clear]
    assert find(w.editor2, "proposal") == [unclear]
    assert find(w.editor2, "lakeview") == []
    assert find(w.outsider, "अकरा") == [] and find(w.outsider, "proposal", group) == []
    snippet = as_(api, w, w.editor2, "select snippet from pulse.chat_voice_search('proposal',null,60)")[0]["snippet"]
    assert "proposal" in snippet.lower()
    # An AI employee reads the clear words, and for the other only that it was not clear (and the rough gist).
    with owner.transaction():  # what the AI employees' dispatch (the owner's functions) reads
        set_tenant(owner, w.org)
        said = {m: owner.execute("select pulse.agent_message_text(%s,'') t", (m,)).fetchone()["t"] for m in (clear, unclear)}
    assert "उद्या सकाळी" in said[clear]
    assert "not clear" in said[unclear] and "garbled" not in said[unclear] and "Send the proposal" in said[unclear]


def test_an_older_transcript_is_made_again_in_place_without_waking_anyone(api, worker, team, monkeypatch):  # noqa: F811
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Old notes',%s) id", ([w.editor2],))["id"]
    fid, mid = _note(api, w, group)
    _heard(worker, w, mid, fid, "old whisper nonsense", None, engine=None)
    m = _worker_module()
    monkeypatch.setattr(m, "hear", lambda model, indic, audio: {"text": "नवीन शब्द", "clear": True, "confidence": 0.93, "language": "mr", "engine": "test-engine", "gist": None})
    monkeypatch.setattr(m, "pcm", lambda data: b"")
    assert m.has_heard(worker)
    assert m.rehear(worker, w.org, None, None) == 1
    assert m.rehear(worker, w.org, None, None) == 0  # done once
    with worker.transaction():
        set_tenant(worker, w.org)
        t = worker.execute("select state,body,clear,engine,confidence from pulse_priv.chat_voice_transcript where message_id=%s", (mid,)).fetchone()
    assert t["state"] == "done" and t["body"] == "नवीन शब्द" and t["clear"] is True and t["engine"] == "test-engine" and float(t["confidence"]) == 0.93


def test_a_stored_guess_that_is_not_english_is_dropped(api, worker, team):  # noqa: F811
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Guesses',%s) id", ([w.editor2],))["id"]
    f1, english_one = _note(api, w, group)
    f2, devanagari = _note(api, w, group)
    _heard(worker, w, english_one, f1, "x", False, gist="Send the new proposal")
    _heard(worker, w, devanagari, f2, "y", False, gist="ग्रूप मदे आनी पर्सनल चाट मदे")
    m = _worker_module()
    assert m.scrub_guesses(worker, w.org) == 1
    heard = {r["message_id"]: r for r in as_(api, w, w.editor2, "select * from pulse.chat_voice_heard(%s)", (group,))}
    assert heard[english_one]["gist"] == "Send the new proposal" and heard[devanagari]["gist"] is None


def test_a_guess_is_shown_only_when_it_is_english():
    m = _worker_module()
    assert m.english("Send the new proposal to the client today")
    assert not m.english("ग्रूप मदे आनी पर्सनल चाट मदे option")  # the speech written again, not translated
    assert not m.english("")


def test_agreement_is_one_for_the_same_words_and_low_for_others():
    m = _worker_module()
    assert m.agreement("उद्या सकाळी, शूट आहे!", "उद्या सकाळी शूट आहे") == 1.0
    assert m.agreement("उद्या सकाळी शूट आहे", "") == 0.0
    assert m.agreement("उद्या सकाळी शूट आहे", "कल सुबह मीटिंग है") < 0.5


def test_an_english_note_is_heard_with_the_company_names_as_whisper_prompt(api, worker, team):  # noqa: F811
    """BHARATA-2: the newest clients and the products with a size go into Whisper's prompt (English pass only)."""
    w, m = team, _worker_module()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'TEST Desai Dairy')", (uuid.uuid4(), w.org))
        worker.execute("insert into pulse.erp_item(id,org_id,kind,code,name,price,gst_rate,status) values(%s,%s,'product','TS-5.0','TEST Sunbox 5.0',100,5,'active')", (uuid.uuid4(), w.org))
    with worker.transaction():
        set_tenant(worker, w.org)
        p = m.vocabulary(worker)
    assert p.startswith("Quotation request.") and "TEST Desai Dairy" in p and "TEST Sunbox 5.0" in p and "sizes in kW" in p, p
    assert m.prompt_of([], []) is None
    assert len(m.prompt_of([f"Client number {i}" for i in range(100)], [])) <= 600
    seen = {}

    class Fake:
        def detect(self, audio): return {"en": 0.99, "hi": 0.005, "mr": 0.005}
        def transcribe(self, audio, **kw):
            seen.update(kw)
            return iter([]), None
    m.speech_pieces = lambda audio, max_s=20: ([audio], 3.0)
    m.gist = lambda model, speech: None
    m.hear(Fake(), None, b"x", p)
    assert seen.get("initial_prompt") == p and seen.get("language") == "en"


def test_quote_words_misheard_are_put_right_and_nothing_else():
    """BHARATA-3: suite run 9's Marathi notes: "शहराब आहे" (so Bharata asked where the transport was), "किलोवर्ड",
    "किलो वॅट", "बंजुरी"; a kilo of sugar and a kilometre stay as they are."""
    m = _worker_module()
    assert m.fix_words("देसाई डेअरीसाठी एक बारा किलो वॅट सिस्टमचे कोटेशन करा वाहतूक शहराब आहे मालकांना बंजुरीसाठी पाठवा", "mr") == (
        "देसाई डेअरीसाठी एक बारा किलोवॅट सिस्टमचे कोटेशन करा वाहतूक शहराबाहेर मालकांना मंजुरीसाठी पाठवा", 3)
    assert m.fix_words("एका पाच किलोवर्ड सिस्टमचे कोटेशन करा", "mr") == ("एका पाच किलोवॅट सिस्टमचे कोटेशन करा", 1)
    assert m.fix_words("एक बारह किलो वाट सिस्टम, मालिक को बंजूरी के लिए भेज दो", "hi") == ("एक बारह किलोवाट सिस्टम, मालिक को मंज़ूरी के लिए भेज दो", 2)
    for same, lang in [("वाहतूक शहराबाहेर जोडा, पाच किलोवॅट", "mr"), ("दहा किलो साखर आणि किलोमीटर", "mr"), ("five kilo what system", "en"), ("", None)]:
        assert m.fix_words(same, lang) == (same, 0)


def test_a_marathi_note_is_heard_with_its_quote_words_put_right():
    m = _worker_module()

    class Whisper:
        def detect(self, audio): return {"en": 0.05, "hi": 0.35, "mr": 0.6}

    class Indian:
        def ready(self): return True
        def conformer(self, lang, pieces): return "वाहतूक शहराब आहे" if lang == "mr" else "वाहतूक शहर बाहर"
        def whisper(self, lang, speech): return "वाहतूक शहराब आहे" if lang == "mr" else "वाहतुक शहर का"
    m.speech_pieces = lambda audio, max_s=20: ([audio], 3.0)
    m.gist = lambda model, speech: None
    out = m.hear(Whisper(), Indian(), b"x")
    assert out["language"] == "mr" and out["text"] == "वाहतूक शहराबाहेर" and out["fixed"] == 1 and out["clear"]


def test_one_model_at_a_time_lets_the_others_go():
    """BHARATA-3: PULSE_VOICE_ONE_MODEL=1 (a shared server): loading one model lets every other one go first."""
    m = _worker_module()
    lazy, indic = m.Lazy(), m.Indic()
    lazy.model, indic.models = object(), {"ic:mr": object()}
    m._only(indic)
    assert lazy.model is not None and indic.models, "off by default: both stay"
    m.ONE_MODEL = True
    m._only(indic)
    assert lazy.model is None and indic.models, "Indic loads: Whisper goes"
    lazy.model = object()
    m._only(lazy)
    assert indic.models == {} and lazy.model is not None, "Whisper loads: the Indian-language engines go"
