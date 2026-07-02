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
from concurrent.futures import ThreadPoolExecutor

EVO_HOST = "evo1.ekiom.net"
EVO_LOGIN, EVO_PWD = "NCADMIN", "NCADMIN"
BASE = f"https://{EVO_HOST}/manager/api"
AUTH = base64.b64encode(f"{EVO_LOGIN}:{EVO_PWD}".encode()).decode()
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE

R_TRANS  = "100000012"   # Num. trans. Agen vs Camp (agent × campagne × résolution)
R_SESS   = "100000052"   # Sesiones de agentes (durée de connexion)
R_DETAIL = "100000077"   # Listado de transacciones — détail par transaction (voir correctif RA plus bas)

def clean_name(s):
    """Evolution renvoie souvent 'Prenom Prenom Nom' — on retire les mots consécutifs dupliqués."""
    out = []
    for w in str(s).split():
        if not out or out[-1].lower() != w.lower():
            out.append(w)
    return " ".join(out)

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
    # Égalité stricte AVANT correction : "Accord" passait, mais "Accord RdV" (variante utilisée
    # par certaines campagnes, ex. COVID_19) tombait dans "oth" → accords non comptés, absents du
    # CU/DMC. Aligné sur is_tft() qui utilise déjà une correspondance par préfixe.
    r = res.split(' [')[0].strip().lower()
    if r.startswith("accord"): return ("acc", 2)     # contact utile positif (Accord, Accord RdV, ...)
    if r.startswith("refus"): return ("ref", 1)       # CU négatif (Refus, Refus Répondre, ...)
    if "hors" in r and "cible" in r: return ("hc", 1)  # reçu ET traité, hors périmètre → compte en CU (décision Tarik)
    return ("oth", 0)                               # non traités : répondeur, faux n°, rappel, système…

def is_tft(res):
    """Total Fiches Traitées = accord + refus + refus de répondre + hors cible (exclut faux n°, répondeur, rappel, système)."""
    r = res.split(' [')[0].strip().lower()
    return ('accord' in r) or ('refus' in r) or ('hors' in r and 'cible' in r)

def _ingest_row(r, sqlStats, agByKey, names, ra=False):
    """Comptabilise une ligne agrégée (idCampanya/idFinal/Resolution/Transactions/AT_Agent/idAgente/nomAgente).
    Utilisé par le passage principal (rapport 100000012) ET par le correctif RA (rapport détail 100000077,
    dont chaque transaction individuelle est convertie en ligne équivalente Transactions=1 avant appel).
    ra=True marque les lignes récupérées via le correctif « service de relance automatique » (voir
    export()) — propagé jusqu'au dashboard pour afficher clairement l'origine de ces appels."""
    nb = r.get("Transactions", 0) or 0
    if not nb:
        return
    kind, ctd = resmap(str(r.get("Resolution", "")))
    cid = str(r.get("idCampanya")); cnom = str(r.get("nomCampanya", "")).split(' [')[0]
    sqlStats.append({
        "idCampanya": cid, "campNom": cnom, "idFinal": str(r.get("idFinal")),
        "finalNom": str(r.get("nomFinal", "")).split(' [')[0],
        "contactado": ctd, "claseFinal": 2, "nb": nb,
        "dmc_sec": hms(r.get("AT_Agent")) if ctd > 0 else None,
        "dmt_sec": None, "attente_sec": None,
        "sum_call_sec": hms(r.get("AT_Agent")) * nb, "sum_wrapup_sec": 0,
        "ra": ra,
    })
    aid = str(r.get("idAgente"))
    names[aid] = clean_name(str(r.get("nomAgente", "")).split(' [')[0])
    a = agByKey[(aid, cid)]; a["camp"] = cnom; a["nb"] += nb; a["def"] += nb
    if ra: a["ra_nb"] += nb
    if kind == "acc": a["cuPos"] += nb; a["cuTotal"] += nb
    elif kind == "ref": a["cuTotal"] += nb
    elif kind == "hc": a["cuTotal"] += nb; a["hc"] += nb
    if is_tft(str(r.get("Resolution", ""))): a["tft"] += nb
    t = hms(r.get("AT_Agent"))
    if t: a["dmt_sum"] += t * nb; a["dmt_n"] += nb
    # Durée de COMMUNICATION : seulement sur les contacts utiles (accord+refus+hors cible),
    # sinon les répondeurs/faux n° (très courts) écrasent la moyenne.
    if t and kind in ("acc", "ref", "hc"): a["comm_sum"] += t * nb; a["comm_n"] += nb

def export(fdesde, fhasta, hdesde=None, hhasta=None):
    svc_rows = _get("/v1/measurable/services?format=json").get("DataSet", [])
    services = [str(r["EntityId"]) for r in svc_rows]
    svc_names = {str(r["EntityId"]): str(r.get("EntityName", "")) for r in svc_rows}
    base_p = {"fdesde": fdesde, "fhasta": fhasta}
    if hdesde: base_p["hdesde"] = hdesde
    if hhasta: base_p["hhasta"] = hhasta

    sqlStats = []
    agByKey = collections.defaultdict(lambda: {"nb": 0, "cuPos": 0, "cuTotal": 0, "def": 0, "tft": 0, "hc": 0, "ra_nb": 0, "dmt_sum": 0, "dmt_n": 0, "comm_sum": 0, "comm_n": 0, "camp": ""})
    seen_sessions = {}  # idSesionAgente -> (idAgente, durée) ; dédup cross-service + GroupLevel
    names = {}          # idAgente -> nom nettoyé (pour l'historique : agents pas connectés maintenant)
    native_camps_by_svc = collections.defaultdict(set)  # idsvc -> {idCampanya déjà vus via R_TRANS}
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
            native_camps_by_svc[sid].add(str(r.get("idCampanya")))
            _ingest_row(r, sqlStats, agByKey, names)
        # Sessions : 1 ligne (GroupLevel 0) = 1 session. Dédup par idSesionAgente car une
        # même session revient sous plusieurs services → sinon gonflement (>24h/jour).
        for s in se:
            if s.get("GroupLevel") != 0:
                continue
            sid_ses = s.get("idSesionAgente")
            if sid_ses in seen_sessions:
                continue
            seen_sessions[sid_ses] = (str(s.get("idAgente")), hms(s.get("Session_duration")))

    # ── Correctif « relance automatique » (RA) ──────────────────────────────────────────
    # Un service RA (ex. "RA - HYUNDAI_...") peut traiter, via un segment croisé, des
    # transactions officiellement rattachées à une AUTRE campagne. Le rapport agrégé
    # (R_TRANS) les ignore silencieusement dans ce cas — confirmé sur pièce (fiche 15345510,
    # agent Fawnat, campagne AUDI_EMULATEUR, traitée par le service RA HYUNDAI, absente de
    # R_TRANS mais retrouvée via le rapport détail R_DETAIL en croisant idsvc+idcampa).
    # Coût borné : 1 seul service RA aujourd'hui → ~100 appels supplémentaires par cycle.
    ra_services = [sid for sid in services if svc_names.get(sid, "").upper().startswith("RA")]
    raDetail = []   # détail des appels RA TRAITÉS PAR UN AGENT (qui, quand, attente, conv)
    raSystem = 0    # clôtures automatiques (SYSTEM) : comptées pour la QS, détail inutile (milliers de lignes)
    if ra_services:
        camp_rows = _get("/v1/measurable/campaigns?format=json").get("DataSet", [])
        all_camp_ids = [str(c["EntityId"]) for c in camp_rows]
        camp_name_by_id = {str(c["EntityId"]): str(c.get("EntityName", "")) for c in camp_rows}
        name_to_aid = {}
        for aid, nom in names.items():
            name_to_aid.setdefault(nom.strip().lower(), aid)
        def _probe(args):
            # maxnumrows : le rapport renvoie les transactions les plus RÉCENTES d'abord et
            # coupe au plafond. À 500, les couples chargés en clôtures auto (ex. MERCEDES 729 :
            # 500+ lignes/jour) perdaient les appels du début de matinée → totaux agents faux
            # (constaté le 02/07 : accord Fazna 10:06 et refus Fawnat 10:04 tronqués).
            sid, cid = args
            try:
                rows = invoke(R_DETAIL, {**base_p, "idsvc": sid, "idcampa": cid, "maxnumrows": "5000"})
                if len(rows) >= 5000:
                    print(f"AVERTISSEMENT: plafond 5000 atteint sur svc={sid} camp={cid} — troncature possible", file=sys.stderr)
                return cid, rows
            except Exception:
                return cid, []
        _ts_re = re.compile(r'/Date\((\d+)')
        def _ts(v):
            m = _ts_re.search(str(v) or "")
            return int(m.group(1)) if m else None
        for sid in ra_services:
            native = native_camps_by_svc.get(sid, set())
            # On sonde TOUTES les campagnes (natives incluses) pour le DÉTAIL — mais on
            # n'injecte en stats agrégées que les campagnes étrangères (les natives sont
            # déjà comptées par R_TRANS, sinon double comptage).
            targets = [(sid, cid) for cid in all_camp_ids]
            # ~100 appels réseau indépendants par service RA : parallélisés, sinon le cycle
            # dépasse l'intervalle de la tâche planifiée (1min) — testé à 1m52 en séquentiel.
            with ThreadPoolExecutor(max_workers=32) as pool:
                for cid, det in pool.map(_probe, targets):
                    for tx in det:
                        if tx.get("GroupLevel") != 0:
                            continue
                        agent_nom = clean_name(str(tx.get("Agent", "")))
                        is_system = (not agent_nom or agent_nom.strip().upper() == "SYSTEM")
                        if is_system:
                            raSystem += 1  # compté pour la QS ; pas de ligne de détail (bruit)
                            continue
                        raDetail.append({
                            "ts": _ts(tx.get("DateTime")), "agent": agent_nom,
                            "campId": cid, "camp": camp_name_by_id.get(cid, cid).split(' [')[0],
                            "fiche": str(tx.get("Customer", "")), "res": str(tx.get("Description", "")),
                            "queue_sec": hms(tx.get("QueueT")), "conv_sec": hms(tx.get("ConvT")),
                            "svc": svc_names.get(sid, ""),
                        })
                        # Stats agrégées : uniquement campagnes étrangères (les natives sont déjà
                        # comptées par R_TRANS — double comptage sinon).
                        if cid in native:
                            continue
                        aid = name_to_aid.get(agent_nom.strip().lower(), "ra_" + agent_nom.replace(" ", "_"))
                        names.setdefault(aid, agent_nom)
                        synth = {
                            "idCampanya": cid, "nomCampanya": camp_name_by_id.get(cid, cid),
                            "idFinal": tx.get("ResolutionID"), "nomFinal": tx.get("Description", ""),
                            "Resolution": tx.get("Description", ""), "Transactions": 1,
                            "AT_Agent": tx.get("AgT"), "idAgente": aid, "nomAgente": agent_nom,
                        }
                        _ingest_row(synth, sqlStats, agByKey, names, ra=True)
        raDetail.sort(key=lambda r: r["ts"] or 0, reverse=True)

    # Heures de connexion réelles par agent = somme des sessions DISTINCTES (déjà dédupées).
    agent_sess_total = collections.defaultdict(int)
    for _sid, (aid, dur) in seen_sessions.items():
        agent_sess_total[aid] += dur
    # Réparti sur les campagnes de l'agent au prorata des fiches traitées (approx : la session
    # n'est pas découpée par campagne dans Evolution).
    camps_by_agent = collections.defaultdict(list)
    for (aid, cid), v in agByKey.items():
        camps_by_agent[aid].append((cid, v))
    sqlAgentCamps = []  # lignes PLATES — le serveur (evoProcessAgentCamps) les regroupe par agent
    agents = []
    for aid, lst in camps_by_agent.items():
        tot = sum(v["nb"] for _, v in lst) or 1
        agent_sess = agent_sess_total.get(aid, 0)
        nom = names.get(aid, "Agent #" + aid)
        agents.append({"id": aid, "nom": nom})
        for cid, v in lst:
            sqlAgentCamps.append({
                "idAgente": aid, "idCampanya": cid, "campNom": v["camp"], "agentNom": nom,
                "nb": v["nb"], "cuPos": v["cuPos"], "cuTotal": v["cuTotal"], "definitifs": v["def"],
                "tft": v["tft"], "hc": v["hc"], "ra_nb": v["ra_nb"], "talk_sec": v["dmt_sum"],
                "comm_sec": v["comm_sum"], "comm_n": v["comm_n"],
                "session_span_sec": round(agent_sess * v["nb"] / tot),
                "dmt_sec": round(v["dmt_sum"] / v["dmt_n"]) if v["dmt_n"] else None,
                "dmc_sec": round(v["comm_sum"] / v["comm_n"]) if v["comm_n"] else None,
            })
    # date ISO du jour des données (fdesde dd/mm/yyyy -> yyyy-mm-dd) pour le filtre date du dashboard
    try:
        dd, mm, yy = fdesde.split("/"); data_date = f"{yy}-{mm.zfill(2)}-{dd.zfill(2)}"
    except Exception:
        data_date = None
    return {"fdesde": fdesde, "fhasta": fhasta, "hdesde": hdesde, "hhasta": hhasta, "dataDate": data_date,
            "sqlStats": sqlStats, "sqlAgentCamps": sqlAgentCamps, "agents": agents,
            "raDetail": raDetail, "raSystem": raSystem}

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
