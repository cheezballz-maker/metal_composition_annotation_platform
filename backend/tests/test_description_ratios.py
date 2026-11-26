"""Ordered description ratios: schema, calculation, identity, HTTP persistence and exports."""
from copy import deepcopy
import importlib
import json

import pytest
from fastapi.testclient import TestClient
from backend.composition_schema import validate_record
from backend.composition_export import canonical_composition, corrected_record
from backend.description_ratio import calculate_ratio, effective_constituents
from backend.tests.test_description_extensions import description_save_workspace
from backend.tests.test_review_workflow import ENV_KEYS, auth

CONTENT = "Alloy source claim"

def workspace(root):
    description_save_workspace(root)
    path=root/"documents/source-a.json"
    doc=json.loads(path.read_text())
    for i,row in enumerate(doc["compositions"][0]["data"]["constituents"]):
        row.update(amount_comparator="range",amount_unit="wt%",amount_lower_value=(i+1)*2,amount_upper_value=(i+1)*2,amount_lower_endpoint_type="closed",amount_upper_endpoint_type="closed")
        row.pop("amount_value",None)
    doc["baseline"]["compositions"]=[deepcopy(doc["compositions"][0]["data"])]
    path.write_text(json.dumps(doc))
    return doc


def ratio(values=None):
    rule={"constraint_id":"r1","mode":"ratio","member_refs":["Cu","Fe","Al"]}
    if values is not None:rule["ratio_values"]=values
    return rule


def as_record(doc,rule):
    result=deepcopy(doc["baseline"]);result["compositions"][0]["constraints"]=[rule];return result


def test_ratio_types_order_and_claim_isolation(tmp_path):
    doc=workspace(tmp_path/"review")
    for values in [None,[1,2,3],[1,[2,4],0]]:
        record=as_record(doc,ratio(values));assert validate_record(record,CONTENT)==record
    for values in [[],[1,2],[0,0,0],[1,True,3],[1,-1,3],[1,[4,2],3],[1,float("inf"),3],[1,[None,2],3]]:
        with pytest.raises(ValueError):validate_record(as_record(doc,ratio(values)),CONTENT)
    for patch in [{"basis":"mass"},{"evidence":"Alloy"},{"selection":{"min":1,"max":2}},{"member_refs":["Cu"]},{"member_refs":["Cu","Cu"]},{"member_refs":["Cu","Zn"]}]:
        with pytest.raises(ValueError):validate_record(as_record(doc,{**ratio(),**patch}),CONTENT)
    claim=as_record(doc,ratio([1,2,3]));claim["meta"]["section"]="claim"
    with pytest.raises(ValueError,match="mode"):validate_record(claim,CONTENT)
    forward=as_record(doc,ratio([1,2,3]))["compositions"][0]
    reverse=deepcopy(forward);reverse["constraints"][0]["member_refs"].reverse()
    assert canonical_composition(forward)!=canonical_composition(reverse)
    assert forward["constraints"][0]["member_refs"]==["Cu","Fe","Al"]


def test_calculated_bounds_units_and_missing_base(tmp_path):
    doc=workspace(tmp_path/"review");rows=doc["compositions"][0]["data"]["constituents"]
    assert calculate_ratio(ratio(),rows)==[(1,1),(2,2),(3,3)]
    rows[0].update(amount_lower_value=2,amount_upper_value=4)
    rows[1].update(amount_lower_value=6,amount_upper_value=12)
    assert calculate_ratio(ratio(),rows)==[(1,1),(1.5,6),(1.5,3)]
    rows[1].update(amount_lower_value=60000,amount_upper_value=120000,amount_unit="ppm by weight")
    assert calculate_ratio(ratio(),rows)[1]==(1.5,6)
    rows[1]["amount_unit"]="at%"
    with pytest.raises(ValueError,match="compatible"):calculate_ratio(ratio(),rows)
    rows[1]["amount_unit"]="wt%";rows[0]["amount_lower_value"]=0
    with pytest.raises(ValueError,match="positive"):calculate_ratio(ratio(),rows)
    rows[0].update(amount_lower_value=2,amount_upper_value=4,amount_comparator="balance")
    with pytest.raises(ValueError,match="balance"):calculate_ratio(ratio(),rows)
    rows[0]={"constituent_name":"Cu","constituent_status":"included","amounts":[{"preferred_order":0,"amount_comparator":None},{"preferred_order":1,"amount_comparator":"range","amount_unit":"wt%","amount_lower_value":2,"amount_upper_value":4}]}
    with pytest.raises(ValueError,match="Base"):calculate_ratio(ratio(),rows)


def test_ratios_http_export_dynamic_inheritance_and_rollback(tmp_path,monkeypatch):
    for key in ENV_KEYS:monkeypatch.delenv(key,raising=False)
    root=tmp_path/"review";doc=workspace(root)
    child=deepcopy(doc["compositions"][0]);child.update(id="seed:2",seed_node_no=2)
    child["data"].update(node_no=2,composition_name="Child",inherits_from=1,constituents=[{"constituent_name":"Ti","constituent_status":"included","amount_comparator":"equal","amount_value":1,"amount_unit":"wt%"}],constraints=[{**ratio(),"constraint_id":"child-ratio","member_refs":["Cu","Fe","Ti"]}])
    doc["compositions"].append(child);doc["baseline"]["compositions"].append(deepcopy(child["data"]));(root/"documents/source-a.json").write_text(json.dumps(doc))
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACE",str(root));monkeypatch.setenv("ANNOTATION_USERS_JSON",json.dumps([{"username":"alice","password":"pass"}]))
    from backend import main
    with TestClient(importlib.reload(main).app,headers=auth("alice")) as client:
        endpoint="/api/review/records/source-a";original=client.get(endpoint).json()["document"]
        data=deepcopy(original["compositions"][0]["data"]);data["constraints"]=[ratio(),{**ratio([1,[2,3],4]),"constraint_id":"r2"}]
        saved=client.post(endpoint+"/actions",json={"action":"edit","action_id":"ratio-save","revision":original["revision"],"composition_id":"seed:1","data":data})
        assert saved.status_code==200,saved.text
        current=client.get(endpoint).json()["document"];export=corrected_record(current)
        assert export["compositions"][0]["constraints"]==data["constraints"]
        assert "ratio_values" not in export["compositions"][0]["constraints"][0]
        assert current["compositions"][1]==original["compositions"][1]
        assert calculate_ratio(child["data"]["constraints"][0],effective_constituents(child["data"],export["compositions"]))==[(1,1),(2,2),(.5,.5)]
        data["constituents"][0].update(amount_lower_value=4,amount_upper_value=4)
        saved=client.post(endpoint+"/actions",json={"action":"edit","action_id":"ratio-base-change","revision":current["revision"],"composition_id":"seed:1","data":data})
        assert saved.status_code==200,saved.text
        current=client.get(endpoint).json()["document"];export=corrected_record(current)
        assert calculate_ratio(data["constraints"][0],data["constituents"])[1]==(1,1)
        assert current["compositions"][1]==original["compositions"][1]
        before=(root/"documents/source-a.json").read_bytes();data["constituents"][0].update(amount_lower_value=0,amount_upper_value=0)
        rejected=client.post(endpoint+"/actions",json={"action":"edit","action_id":"ratio-zero-reference","revision":current["revision"],"composition_id":"seed:1","data":data})
        assert rejected.status_code in {400,422},rejected.text
        assert (root/"documents/source-a.json").read_bytes()==before
        assert client.get(endpoint).json()["document"]["revision"]==current["revision"]
