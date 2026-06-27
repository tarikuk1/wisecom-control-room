#!/usr/bin/env python3
"""
evo_push_rest.py — Push CONTINU des données Evolution vers le dashboard (via REST, sans SQL direct).

À planifier (Planificateur de tâches Windows) toutes les 1 minute :
    C:\\Python314\\python.exe <chemin>\\evo_push_rest.py

Tire les rapports REST (agent×campagne + sessions) du JOUR + les mesurables temps réel,
et POST le tout à /api/evo/ingest. Aucun port SQL 1433 requis → contourne le firewall.
Les données restent donc présentes en permanence (un redémarrage Railway est rattrapé
au cycle suivant). Log : evo_push_rest.log à côté du script.
"""
import os, sys, json, urllib.request, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evo_export_rest as ex

DASH = "https://control-room-production-a320.up.railway.app/api/evo/ingest"
SECRET = "286828"
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "evo_push_rest.log")

def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")

def main():
    today = datetime.date.today()
    fd = today.strftime("%d/%m/%Y")
    fh = (today + datetime.timedelta(days=1)).strftime("%d/%m/%Y")  # fhasta EXCLUSIF
    payload = ex.export(fd, fh)
    if not payload.get("sqlAgentCamps"):
        # Pas encore de données aujourd'hui (tôt le matin) → dernier jour clôturé (hier)
        y = today - datetime.timedelta(days=1)
        payload = ex.export(y.strftime("%d/%m/%Y"), today.strftime("%d/%m/%Y"))
    camps = ex._get("/v1/measurable/campaigns?format=json")
    agents = ex._get("/v1/measurable/agents?format=json")
    body = json.dumps({
        "campaigns": camps, "agents": agents, "estado": None,
        "sqlStats": payload["sqlStats"], "sqlFiles": None,
        "sqlAgentCamps": payload["sqlAgentCamps"], "sqlDiag": None,
        "dataDate": payload.get("dataDate"),
    }).encode()
    req = urllib.request.Request(DASH, data=body,
        headers={"X-Evo-Push-Secret": SECRET, "Content-Type": "application/json"}, method="POST")
    r = json.load(urllib.request.urlopen(req, context=ex.CTX, timeout=30))
    log(f"OK stats={len(payload['sqlStats'])} agents={len(payload['sqlAgentCamps'])} date={payload.get('dataDate')} resp={r.get('ok')}")
    print("OK", r)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERREUR {e}")
        print("ERR", e)
        sys.exit(1)
