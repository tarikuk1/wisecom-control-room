#!/usr/bin/env python3
"""
evo_export_rest.py — Export des données de production Evolution via l'API REST Manager.

CONTOURNE le SQL bloqué (port 1433) : tout passe par les rapports REST sur HTTPS (443),
qui sont joignables alors que le SQL direct ne l'est pas.

Produit un payload {sqlStats, sqlAgentCamps} au format attendu par le dashboard Control Room
(mêmes champs que l'ancien push SQL → le dashboard se remplit sans changer server.js).

Usage :
    python evo_export_rest.py 25/06/2026                 # une journée
    python evo_export_rest.py 25/06/2026 26/06/2026      # plage (fhasta EXCLUSIF)
    python evo_export_rest.py 25/06/2026 26/06/2026 09:00:00 20:00:00   # + plage horaire

Sémantique des dates (IMPORTANT) : fhasta est EXCLUSIF (borne = 00:00 du jour).
Pour la journée D, passer fdesde=D et fhasta=D+1. Idem heures (hhasta exclusif).

Sortie : evo_payload_<date>.json à côté du script.
"""
import json, urllib.request, base64, ssl, collections, re, sys, datetime

EVO_HOST = "evo1.ekiom.net"
EVO_LOGIN, EVO_PWD = "NCADMIN", "NCADMIN"
BASE = f"https://{EVO_HOST}/manager/api"
AUTH = base64.b64encode(f"{EVO_LOGIN}:{EVO_PWD}".encode()).decode()
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE

R_TRANS = "100000012"   # Num. trans. Agen vs Camp (agent × campagne × résolution)
R_SESS  = "100000052"   # Sesiones de agentes (durée de connexion)

def _get(path):
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": "Basic " + AUTH})
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=30))

def invoke(rid, params):
    body = json.dumps({"Parameters": [{"Name": k, "Value": v} for k, v in params.items()]}).encode()
    req = urllib.request.Request(f"{BASE}/v1/admin/reports/{rid}/invoke?format=json", data=body,
        headers={"Authorization": "Basic " + AUTH, "Content-Type": "application/json"}, method="POST")
    d = json.load(urllib.request.urlopen(req, context=CTX, timeout=90))
    rd = d.get("ReportData") or {}
    H = [h["Header"] for h in rd.get("Headers", [])]
    return [dict(zip(H, r["Values"])) for r in rd.get("Rows", [])]

def hms(s):
    m = re.match(r'^(\d+):(\d{2}):(\d{2})$', str(s) or '')
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) if m else 0

def resmap(res):
    r = res.split(' [')[0].strip()
    if r == "Accord": return ("acc", 2)            # contact utile positif
    if r in ("Refus", "Refus Répondre", "Refus R�pondre"): return ("ref", 1)  # CU négatif
    return ("oth", 0)                              # autres clôtures (faux n°, répondeur, rappel…)

def export(fdesde, fhasta, hdesde=None, hhasta=None):
    services = [str(r["EntityId"]) for r in _get("/v1/measurable/services?format=json").get("DataSet", [])]
    base_p = {"fdesde": fdesde, "fhasta": fhasta}
    if hdesde: base_p["hdesde"] = hdesde
    if hhasta: base_p["hhasta"] = hhasta

    sqlStats = []
    agByKey = collections.defaultdict(lambda: {"nb": 0, "cuPos": 0, "cuTotal": 0, "def": 0, "dmt_sum": 0, "dmt_n": 0, "camp": ""})
    seen_sessions = {}  # idSesionAgente -> (idAgente, durée) ; dédup cross-service + GroupLevel
    for sid in services:
        try:
            tr = invoke(R_TRANS, {**base_p, "idsvc": sid})
        except Exception:
            continue
        rows = [r for r in tr if r.get("GroupLevel") == 0 and (r.get("Transactions") or 0)]
        if not rows:
            continue
        try:
            se = invoke(R_SESS, {**base_p, "idsvc": sid})
        except Exception:
            se = []
        for r in rows:
            nb = r.get("Transactions", 0) or 0
            kind, ctd = resmap(str(r.get("Resolution", "")))
            cid = str(r.get("idCampanya")); cnom = str(r.get("nomCampanya", "")).split(' [')[0]
            sqlStats.append({
                "idCampanya": cid, "campNom": cnom, "idFinal": str(r.get("idFinal")),
                "finalNom": str(r.get("nomFinal", "")).split(' [')[0],
                "contactado": ctd, "claseFinal": 2, "nb": nb,
                "dmc_sec": hms(r.get("AT_Agent")) if ctd > 0 else None,
                "dmt_sec": None, "attente_sec": None,
                "sum_call_sec": hms(r.get("AT_Agent")) * nb, "sum_wrapup_sec": 0,
            })
            a = agByKey[(str(r.get("idAgente")), cid)]; a["camp"] = cnom; a["nb"] += nb; a["def"] += nb
            if kind == "acc": a["cuPos"] += nb; a["cuTotal"] += nb
            elif kind == "ref": a["cuTotal"] += nb
            t = hms(r.get("AT_Agent"))
            if t: a["dmt_sum"] += t * nb; a["dmt_n"] += nb
        # Sessions : 1 ligne (GroupLevel 0) = 1 session. Dédup par idSesionAgente car une
        # même session revient sous plusieurs services → sinon gonflement (>24h/jour).
        for s in se:
            if s.get("GroupLevel") != 0:
                continue
            sid_ses = s.get("idSesionAgente")
            if sid_ses in seen_sessions:
                continue
            seen_sessions[sid_ses] = (str(s.get("idAgente")), hms(s.get("Session_duration")))

    # Heures de connexion réelles par agent = somme des sessions DISTINCTES (déjà dédupées).
    agent_sess_total = collections.defaultdict(int)
    for _sid, (aid, dur) in seen_sessions.items():
        agent_sess_total[aid] += dur
    # Réparti sur les campagnes de l'agent au prorata des fiches traitées (approx : la session
    # n'est pas découpée par campagne dans Evolution).
    camps_by_agent = collections.defaultdict(list)
    for (aid, cid), v in agByKey.items():
        camps_by_agent[aid].append((cid, v))
    sqlAgentCamps = []
    for aid, lst in camps_by_agent.items():
        tot = sum(v["nb"] for _, v in lst) or 1
        agent_sess = agent_sess_total.get(aid, 0)
        camps = []
        for cid, v in lst:
            camps.append({
                "idCampanya": cid, "campNom": v["camp"], "nb": v["nb"],
                "cuPos": v["cuPos"], "cuTotal": v["cuTotal"], "definitifs": v["def"],
                "session_span_sec": round(agent_sess * v["nb"] / tot),
                "dmt_sec": round(v["dmt_sum"] / v["dmt_n"]) if v["dmt_n"] else None,
            })
        sqlAgentCamps.append({"idAgente": aid, "camps": camps})
    return {"fdesde": fdesde, "fhasta": fhasta, "hdesde": hdesde, "hhasta": hhasta,
            "sqlStats": sqlStats, "sqlAgentCamps": sqlAgentCamps}

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        d = datetime.date.today()
        fd = d.strftime("%d/%m/%Y"); fh = (d + datetime.timedelta(days=1)).strftime("%d/%m/%Y")
    else:
        fd = args[0]
        if len(args) >= 2:
            fh = args[1]
        else:  # une seule date → journée complète (fhasta = jour+1, exclusif)
            dd = datetime.datetime.strptime(fd, "%d/%m/%Y").date()
            fh = (dd + datetime.timedelta(days=1)).strftime("%d/%m/%Y")
    hd = args[2] if len(args) >= 3 else None
    hh = args[3] if len(args) >= 4 else None
    payload = export(fd, fh, hd, hh)
    import os
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "evo_payload_" + fd.replace("/", "") + ".json")
    json.dump(payload, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"OK : {len(payload['sqlStats'])} lignes stats, {len(payload['sqlAgentCamps'])} agents -> {out}")
