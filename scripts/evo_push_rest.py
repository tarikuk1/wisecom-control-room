#!/usr/bin/env python3
"""
evo_push_rest.py — Push CONTINU des données Evolution vers le dashboard (via REST, sans SQL direct).

À planifier (Planificateur de tâches Windows) toutes les 1 minute :
    C:\\Python314\\python.exe <chemin>\\evo_push_rest.py

Tire les rapports REST (agent×campagne + sessions) du JOUR + les mesurables temps réel,
et POST le tout à /api/evo/ingest. Aucun port SQL 1433 requis → contourne le firewall.

HISTORIQUE DÉFINITIF (auto-guérison) : chaque journée poussée est archivée EN LOCAL
(dossier history/ à côté du script). À chaque cycle, après avoir poussé le jour courant,
le script demande au serveur la liste des dates qu'il possède et re-pousse toute date
présente en local mais absente côté serveur. Ainsi, un redéploiement Railway (qui recrée
un conteneur vide) est intégralement rattrapé au cycle suivant (< 1 min), sans intervention.

Usage :
    python evo_push_rest.py                 # jour courant + réconciliation historique
    python evo_push_rest.py 01/07/2026       # (re)construit et pousse UNE journée précise
Log : evo_push_rest.log à côté du script.
"""
import os, sys, json, urllib.request, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evo_export_rest as ex

BASE = "https://control-room-production-a320.up.railway.app"
DASH = BASE + "/api/evo/ingest"
HIST_URL = BASE + "/api/evo/history-dates"
SECRET = "286828"
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "evo_push_rest.log")
HIST_DIR = os.path.join(HERE, "history")           # archive locale permanente (1 fichier / journée)
os.makedirs(HIST_DIR, exist_ok=True)

def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")

def build_body(day):
    """Exporte la journée `day` (date) et renvoie le body JSON prêt à POST (ou None si vide)."""
    fd = day.strftime("%d/%m/%Y")
    fh = (day + datetime.timedelta(days=1)).strftime("%d/%m/%Y")
    payload = ex.export(fd, fh)
    if not payload.get("sqlAgentCamps") and not payload.get("sqlStats"):
        return None, payload
    camps = ex._get("/v1/measurable/campaigns?format=json")
    agents = ex._get("/v1/measurable/agents?format=json")
    body = {
        "campaigns": camps, "agents": agents, "estado": None,
        "sqlStats": payload["sqlStats"], "sqlFiles": None,
        "sqlAgentCamps": payload["sqlAgentCamps"], "sqlDiag": None,
        "inbound": payload.get("inbound"),
        "dataDate": payload.get("dataDate"),
    }
    return body, payload

def post(body):
    req = urllib.request.Request(DASH, data=json.dumps(body).encode(),
        headers={"X-Evo-Push-Secret": SECRET, "Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req, context=ex.CTX, timeout=30))

def archive_local(body):
    """Sauvegarde permanente d'une journée en local (source de vérité de l'historique)."""
    dd = body.get("dataDate")
    if dd:
        with open(os.path.join(HIST_DIR, dd + ".json"), "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False)

def server_dates():
    try:
        req = urllib.request.Request(HIST_URL, headers={"X-Evo-Push-Secret": SECRET})
        r = json.load(urllib.request.urlopen(req, context=ex.CTX, timeout=20))
        return set(r.get("dates") or [])
    except Exception as e:
        log(f"history-dates injoignable ({e})")
        return None

def reconcile():
    """Re-pousse toute journée archivée en local mais absente côté serveur (rattrapage déploiement)."""
    have = server_dates()
    if have is None:
        return
    local = [f[:-5] for f in os.listdir(HIST_DIR) if f.endswith(".json")]
    missing = sorted(d for d in local if d not in have)
    for dd in missing:
        try:
            with open(os.path.join(HIST_DIR, dd + ".json"), encoding="utf-8") as f:
                body = json.load(f)
            r = post(body)
            log(f"BACKFILL {dd} -> resp={r.get('ok')}")
        except Exception as e:
            log(f"BACKFILL {dd} ERREUR {e}")

def main():
    # Mode backfill manuel : reconstruit et pousse une journée précise.
    if len(sys.argv) > 1:
        d = datetime.datetime.strptime(sys.argv[1], "%d/%m/%Y").date()
        body, payload = build_body(d)
        if body:
            archive_local(body); r = post(body)
            log(f"MANUEL {body['dataDate']} stats={len(payload['sqlStats'])} resp={r.get('ok')}")
            print("OK", r)
        else:
            print("Aucune donnée pour", sys.argv[1])
        return

    # Jour courant (repli jusqu'à 7 j en arrière si journée encore vide : tôt le matin / week-end).
    today = datetime.date.today()
    body, payload = build_body(today)
    if not body:
        for back in range(1, 8):
            body, payload = build_body(today - datetime.timedelta(days=back))
            if body:
                break
    if body:
        archive_local(body)
        r = post(body)
        log(f"OK stats={len(payload['sqlStats'])} agents={len(payload['sqlAgentCamps'])} date={body.get('dataDate')} resp={r.get('ok')}")
        print("OK", r)
    # Rattrapage : réaligne l'historique serveur sur l'archive locale (après un redéploiement).
    reconcile()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERREUR {e}")
        print("ERR", e)
        sys.exit(1)
