#!/bin/sh
# install-hooks.sh — Installe les hooks Git pour Wisecom Control Room
# Lancer UNE FOIS après avoir cloné le repo : sh install-hooks.sh

HOOK_DIR=".git/hooks"

if [ ! -d "$HOOK_DIR" ]; then
  echo "Erreur : .git/hooks introuvable. Êtes-vous à la racine du repo ?"
  exit 1
fi

cp pre-push "$HOOK_DIR/pre-push"
chmod +x "$HOOK_DIR/pre-push"
echo "✓ Hook pre-push installé dans $HOOK_DIR/pre-push"
echo "  Chaque git push vérifiera la syntaxe JS avant envoi."
