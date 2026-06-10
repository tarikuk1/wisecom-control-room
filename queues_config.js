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
  "Afnor","SOS","LGR","LMDW","LBE","M123","Equisign","Eiffage","Apex","Monetize","HMF"
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
  Evoriel: [
    "Evoriel_Copropriétaire","Evoriel_Copropriétaire_Réitération",
    "Evoriel_Locataire","Evoriel_Locataire_Réitération",
    "Evoriel_Bailleur","Evoriel_Bailleur_Réitération","Sortant Evoriel"
  ],
  Antargaz: ["Antargaz","Antargaz_Client","Antargaz_Sortant"],
  Omoda:    ["Omoda_Entrant","Omoda_WCB","Omoda_SAV"],
  Elvetis:  ["Elvetis_RQ","Elvetis_SAV"],
  "Alcéane": ["Alcéane astreinte","Alcéane interne","Alcéane_Locataires","Alcéane_Urgence","Alceane"],
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
  LMB:  ["LMB_Inscription","LMB_Inscription_Réitération","LMB_Autre demande","LMB_Autre demande_Réitération","LMB_Parent d'enfant"],
  Afnor: [
    "Afnor_RQ_auditeur","Afnor_RQ_planification_audit_suivi",
    "Afnor_RQ_planif_audit_suivi_Réitération","Afnor_RQ_renouvellement_certificat",
    "Afnor_Web Call Back Home Page","Afnor Web Call Back FORMATION","AFNOR Sortant"
  ],
  SOS:      ["SOS _ MA","SOS _ MA _ Réitération"],
  LGR:      ["LGR-SC","LGR-Réitération","LGR Boutique"],
  LMDW:     ["LMDW_FR","Sortant LMDW"],
  LBE:      ["1_LBE_Offre et souscription","2_LBE_Facture et règlement","3_LBE_Autres (vie du contrat)"],
  M123:     ["M123_FR","M123_EN","M123_Boutique","Sortant Maison 123 VIP"],
  Equisign: ["Equisign","Equisign _ Réitération"],
  Eiffage:  ["Eiffage","Eiffage Réitération","Sortant Eiffage"],
  Apex:     ["Apex _ La route des langues","Apex _ Séjours Home Abroad"],
  Monetize: ["Monetize FR"],
  HMF:      ["HMF-BOURGOIN JALLIEU-DERUAZ AUTO"],
};

const SKILLS = [
  "LMDW","Equisign","Visio","Bilingue","Rappel Auto","Rétention",
  "Filippi","MNZ","Eiffage","CNPA","HMF","ND","Delsey","M123",
  "LGR","LMB","Apex","Alcéane","Vivest","LBE","DIVERS","ORECA",
  "AE1","AE2","AE3"
];

module.exports = { CAMPS, QUEUES_MAP, SKILLS };
