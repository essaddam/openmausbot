import assert from "node:assert/strict";
import { test } from "node:test";
import { entityKey, figuresSupported, looksSecret, mentionsWords, quotedIn, terms } from "../src/text.ts";

test("terms fold accents and drop French and English stopwords", () => {
  assert.deepEqual(terms("Comment je configure le VRRP sur le hEX PoE de Célfy ?"), ["configure", "vrrp", "hex", "poe", "celfy"]);
});

test("entity keys are stable across case, accents and spacing", () => {
  assert.equal(entityKey("  DGI-SYSTEM "), entityKey("dgi system"));
  assert.equal(entityKey("Célfy"), "celfy");
});

test("a quote must be the person's own words, ignoring case, accents and spacing", () => {
  assert.ok(quotedIn("je préfère  les réponses COURTES", "Bon, je prefere les réponses courtes en général."));
  assert.ok(!quotedIn("je préfère les réponses longues", "je préfère les réponses courtes"));
  assert.ok(!quotedIn("ok", "ok"));
});

test("figures in a fact must appear in its quotes", () => {
  assert.ok(figuresSupported("Le VPS a 8 Go et répond sur https://vm.example.fr/mcp", ["mon VPS a 8 Go", "l'URL c'est https://vm.example.fr/mcp"]));
  assert.ok(!figuresSupported("Le VPS a 16 Go", ["mon VPS a 8 Go"]));
  assert.ok(!figuresSupported("Les sauvegardes vont dans /srv/backup", ["les sauvegardes vont sur le NAS"]));
});

test("secrets are recognised", () => {
  assert.ok(looksSecret("le mot de passe: Hunter2Hunter2"));
  assert.ok(looksSecret("clé sk-ant-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123"));
  assert.ok(!looksSecret("Nicky préfère les réponses courtes"));
});

test("forgetting matches whole words only", () => {
  assert.ok(mentionsWords("Le client Celfy est sur Exchange SE", "celfy"));
  assert.ok(!mentionsWords("Rendez-vous chez le dentiste", "IST"));
  assert.ok(!mentionsWords("Le client Celfy", "celfy exchange"));
});

test("secrets phrased in a sentence are recognised too", () => {
  assert.ok(looksSecret("Le mot de passe admin: P4ssw0rd!2026"));
  assert.ok(looksSecret("le mdp du routeur est Xk29!pLm"));
  assert.ok(!looksSecret("Le mot de passe se change tous les 90 jours"));
});
