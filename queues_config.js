/**
 * queues_config.js — Configuration des campagnes et files d'attente Wisecom
 *
 * Ce fichier est la SOURCE UNIQUE de vérité pour :
 *   - La liste des campagnes (CAMPS)
 *   - Le mapping queue INO → campagne (QUEUES_MAP)
 *   - La liste des compétences (SKILLS)
 *
 * Mis à jour manuellement lors de l'ajout/modification d'une campagne ou d'une file INO.
 * Dernière mise à jour : 2026-06-10 (calibration export INO 10/06/2026)
 *
 * USAGE (Node.js server.js) :
 *   const { CAMPS, QUEUES_MAP, SKILLS } = require('./queues_config.js');
 *
 * USAGE (dashboard.html — inline via /api/config) :
 *   fetch('/api/config').then(r=>r.json()).then(({CAMPS,QUEUES_MAP,SKILLS})=>{ ... })
 */

const CAMPS = [
  "Voltalis","ELECTROSUR","Vivest","Evoriel","Antargaz","Omoda","Elvetis",
  "Alcéane","MG Motor","Filippi","Nature & Découvertes","Delsey","LMB",
  "Afnor","SOS","LGR","LMDW","LBE","M123","Equisign","Eiffage","Apex","Monetize","HMF",
  "CNPA","Verspieren","Groupama","GS1","MNZ",
  // Clients confirmés dans les Smart Routings INO (relevé 10/06/2026, 83 routings)
  // NB : « Grande récré » = LGR (déjà présent), « maison du Wiskey » = LMDW, « La maison bleue » = LMB
  "Amazon","Evaneos","Kaufman","Médiatel","FairMoove","Hyundai",
  // Présent sur l'Écran RA et dans les historiques, mais jamais déclaré ici (audit 17/07/2026)
  "Velux"
];

const QUEUES_MAP = {
  Voltalis: [
    "Voltalis_Assistance_Autres","Voltalis_Assistance_Autres_Réitération",
    "Voltalis_My Voltalis","Voltalis_My Voltalis_Réitération",
    "Voltalis NPV OPB","Voltalis NPV Leads digitaux",
    "Voltalis NPV_Leroy Merlin","Voltalis_Acquisition_Prospect",
    "Voltalis_Acquisition_A déjà RDV","Voltalis_RDV","Voltalis_RDV_Réitération",
    "Voltalis_Contrôle_Reinter","Voltalis_Prospect","Voltalis_Transfert_ADM",
    "Sortant Voltalis","Sortant Voltalis Leroy Merlin"
  ],
  ELECTROSUR: [
    "ELECTROSUR_Sinistre","ELECTROSUR_Autres","ELECTROSUR_Information",
    "ELECTROSUR_Sinistre_Réitération","ELECTROSUR_Autres_Réitération",
    "ELECTROSUR_Information_Réitération","ELECTROSUR_MOBILE_Sinistre",
    "ELECTROSUR_MOBILE_Autres","ELECTROSUR_MOBILE_Information",
    "ELECTROSUR_MOBILE_Sinistre_Réitération","ELECTROSUR_MOBILE_Autres_Réitération",
    "ELECTROSUR_Magasin_Autres","ELECTROSUR_Magasin_Information"
  ],
  Vivest: [
    "Vivest_Client","Vivest_Client_Réitération","Vivest_Standard",
    "Vivest_Standard_Réitération","Vivest_Astreinte","Vivest_Astreinte_Réitération",
    "Vivest_Interne","Sortant Vivest","Sortant Verspieren"
  ],
  // Evoriel = marques Lamy / Oralia / Richardière côté INO. Les files "Evoriel_Copropriétaire"
  // & co. n'existent PLUS dans les historiques : sans les Lamy_*/Oralia_*/Richardière_*, tout le
  // flux Evoriel tombait en « Autre » (~1 030 appels sur 14 j, audit du 17/07/2026) et chaque file
  // non rattachée réapparaissait en fausse campagne (fallback nom-de-file, dashboard.html).
  // ⚠️ Variantes "Reclamation" SANS accent : elles existent telles quelles côté INO.
  Evoriel: [
    "Lamy_Copro_Espace_Client","Lamy_Copro_Renseignements","Lamy_Copro_Réclamation",
    "Lamy_Locataire_Espace_Client","Lamy_Locataire_Renseignements","Lamy_Locataire_Reclamation",
    "Lamy_Bailleur_Espace_Client","Lamy_Bailleur_Renseignements","Lamy_Bailleur_Reclamation",
    "Oralia_Copro_Espace_Client","Oralia_Copro_Renseignements","Oralia_Copro_Réclamation",
    "Oralia_Locataire_Espace_Client","Oralia_Locataire_Renseignements","Oralia_Locataire_Reclamation",
    "Oralia_Bailleur_Espace_Client","Oralia_Bailleur_Renseignements","Oralia_Bailleur_Reclamation",
    "Richardière_Copro_Espace_Client","Richardière_Copro_Renseignements","Richardière_Copro_Réclamation",
    "Richardière_Locataire_Espace_Client","Richardière_Locataire_Renseignements","Richardière_Locataire_Reclamation",
    "Richardière_Bailleur_Espace_Client","Richardière_Bailleur_Renseignements",
    "Evoriel_EPC","Evoriel_N1","Sortant Evoriel",
    // Anciennes files (conservées pour les dates passées)
    "Evoriel_Copropriétaire","Evoriel_Copropriétaire_Réitération",
    "Evoriel_Locataire","Evoriel_Locataire_Réitération",
    "Evoriel_Bailleur","Evoriel_Bailleur_Réitération"
  ],
  Antargaz: ["Antargaz","Antargaz_Client","Antargaz_Sortant"],
  Omoda:    ["Omoda-Jaecoo","Omoda_Entrant","Omoda_WCB","Omoda_SAV"],
  Elvetis:  ["Elvetis_RQ","Elvetis_SAV"],
  "Alcéane": ["Alcéane","Alcéane Astreinte","Alcéane astreinte","Alcéane interne","Alcéane_Locataires","Alcéane_Urgence","Alceane"],
  "MG Motor": [
    "MG_Autre demande","MG_Information véhicule","MG_Véhicule en concession",
    "MG_Application Ismart","MG Motor","MG Motor Enquete","Sortant MG Motot"
  ],
  Filippi: [
    "Filippi_Hertz Ajaccio_Réservation","Filippi_Hertz Ajaccio_Assistance",
    "Filippi_Hertz Bastia_Réservation","Filippi_Hertz Bastia_Assistance","Filippi_Hertz Bastia_Ville",
    "Filippi_Hertz Calvi_Réservation","Filippi_Hertz Calvi_Assistance",
    "Filippi_Hertz Figari_Réservation","Filippi_Hertz Figari_Assistance",
    "Filippi_Sixt_Ajaccio_Réservation","Filippi_Sixt_Ajaccio_Assistance",
    "Filippi_Sixt_Bastia_Réservation","Filippi_Sixt_Bastia_Assistance",
    "Filippi_Sixt_Figari_Réservation","Filippi_Sixt_Figari_Assistance"
  ],
  "Nature & Découvertes": ["Nature & Découvertes","Nature & Découvertes_Réitération"],
  Delsey: [
    "Delsey_Site FR","Delsey_Site EN","Delsey_Plateforme internet FR",
    "Delsey_Autres Sites FR","Sortant Delsey FR"
  ],
  LMB:  ["LMB_Inscription","LMB_Inscription_Réitération","LMB_Autre demande","LMB_Autre demande_Réitération","LMB_Parent d'enfant","La maison bleue"],
  Afnor: [
    "Afnor","Afnor_Renouvellement_Qualliopi","Afnor_RQ_auditeur","Afnor_RQ_planification_audit_suivi",
    "Afnor_RQ_planif_audit_suivi_Réitération","Afnor_RQ_renouvellement_certificat",
    "Afnor_Web Call Back Home Page","Afnor Web Call Back FORMATION","AFNOR Sortant"
  ],
  SOS:      ["SOS _ MA","SOS _ MA _ Réitération"],
  LGR:      ["LGR-SC","LGR-Réitération","LGR Boutique","Grande récré","Grande récré Boutique","Sortant Grande Récrée"],
  LMDW:     ["LMDW_FR","Sortant LMDW","maison du Wiskey FR"],
  LBE:      ["1_LBE_Offre et souscription","2_LBE_Facture et règlement","3_LBE_Autres (vie du contrat)","LBE _ Offre et souscription","LBE _ Facture et règlement","LBE _ Autres"],
  M123:     ["M123_FR","M123_FR Réitération","M123_EN","M123_Boutique","Sortant Maison 123","Sortant Maison 123 VIP","Maison 123","Maison 123 Boutiques"],
  Equisign: ["Equisign","Equisign _ Réitération"],
  Eiffage:  ["Eiffage","Eiffage Réitération","Sortant Eiffage"],
  Apex:     ["Apex _ La route des langues","Apex _ Séjours Home Abroad"],
  Monetize: ["Monetize FR"],
  HMF:      ["HMF-BOURGOIN JALLIEU-DERUAZ AUTO","HMF - Hotline et RC B2B","Débordement Concessions HMF"],
  // Campagnes confirmées dans les Smart Routings INO (relevé 10/06/2026)
  CNPA:       ["CNPA"],
  Verspieren: ["VERSPIEREN","Verspieren","Sortant Verspieren"],
  Groupama:   ["Groupama"],
  GS1:        ["GS1"],
  MNZ:        ["MNZ","MNZ_FR"],
  // Nouveaux clients relevés dans les Smart Routings INO (noms de routing ; le mapping
  // exact des files d'attente sera affiné via /admin > Analyser les files INO)
  Amazon:        ["Amazon_FR","Amazon_DE","Amazon_ES","Amazon_IT","Amazon_UK"],
  Evaneos:       ["Evaneos"],
  Kaufman:       ["Kaufman"],
  "Médiatel":    ["Médiatel"],
  FairMoove:     ["FairMoove invest","FairMoove"],
  Hyundai:       ["STANDARD HYUNDAI FRANCE","Hyundai"],
  Velux:         ["Velux","Velux ND"],
};

const SKILLS = [
  "LMDW","Equisign","Visio","Bilingue","Rappel Auto","Rétention",
  "Filippi","MNZ","Eiffage","CNPA","HMF","ND","Delsey","M123",
  "LGR","LMB","Apex","Alcéane","Vivest","LBE","DIVERS","ORECA",
  "AE1","AE2","AE3"
];

module.exports = { CAMPS, QUEUES_MAP, SKILLS };
