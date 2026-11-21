# maus-memory — mémoire longue pour OpenMausBot

Une mémoire perso par bot, stockée dans **ta** base Postgres (pgvector + Apache AGE) :

- **Faits datés** : chaque fait a une période de validité. Quand un fait change, l'ancien reste dans l'historique et le nouveau le remplace. Tu peux demander « qu'est-ce qui était vrai le 1er octobre ? ».
- **RAG hybride** : recherche plein texte (accents ignorés), recherche par le sens (embeddings, optionnel) et **graphe de connaissances** (personnes, clients, machines, projets et leurs liens), fusionnés.
- **Dream incrémental par bot** : le service lit les nouveaux échanges de chaque bot quand la conversation se calme, garde ce qui dure et retire ce qui n'est plus vrai. Chaque fait doit citer mot pour mot ce que tu as dit, sinon il est rejeté.
- **Serveur MCP** : 7 outils pour que le bot cherche, ajoute, corrige, oublie et parcoure le graphe.

OpenMausBot reste maître de ses propres notes (`MEMORY.md`) ; ce service vient en plus, branché par un petit patch du cœur (`server/external-memory.ts`).

```
OpenMausBot ──(tour terminé)──▶ /v1/turns ──▶ episodes ──dream──▶ faits + graphe
     ▲                                                              │
     └──(avant chaque tour)── /v1/recall ◀── recherche hybride ◀─────┘
Bot ──MCP (stdio)──▶ memory_search / memory_add / memory_graph … ──▶ Postgres
```

## Démarrer sur la VM

```sh
cd plugins/maus-memory
cp .env.example .env        # remplis MAUS_DB_PASSWORD, MAUS_MEMORY_TOKEN, MAUS_LLM…
docker compose up -d        # Postgres (AGE + pgvector) + le service sur 127.0.0.1:8787
# Recherche par le sens en local :
docker compose --profile ollama up -d && docker compose exec ollama ollama pull bge-m3
```

Rien n'est exposé sur Internet : le service et Postgres écoutent sur `127.0.0.1`. Pour y accéder depuis une autre machine, passe par Tailscale/NetBird/WireGuard.

### Le modèle du dream

| `MAUS_LLM` | Pour quoi | Variables |
| --- | --- | --- |
| `anthropic` | API Anthropic, ou l'URL compatible Anthropic de ton fournisseur | `MAUS_LLM_URL`, `MAUS_LLM_MODEL`, `MAUS_LLM_KEY` |
| `openai` | Toute API compatible OpenAI (GLM, Kimi, Ollama `http://ollama:11434/v1`…) | idem |
| `claude-cli` | Ton abonnement Claude via la CLI `claude`, isolée (sans outils, MCP ni hooks) | `MAUS_LLM_MODEL` (ex. `haiku`) ; uniquement avec `npm start` sur l'hôte |
| `none` | Pas de dream : les échanges attendent | — |

Sans modèle, rien n'est perdu : les échanges restent en file et seront lus dès qu'un modèle est configuré.

## Brancher OpenMausBot

Dans `~/.openmausbot/config.json` (ou avec `OMB_EXTERNAL_MEMORY_URL` / `OMB_EXTERNAL_MEMORY_TOKEN`), puis redémarre OpenMausBot :

```json
{
  "memory": {
    "external": { "url": "http://127.0.0.1:8787", "token": "le MAUS_MEMORY_TOKEN", "recallTimeoutMs": 1500 }
  }
}
```

- L'adresse doit être en `https`, ou en `http` sur cette machine ou un réseau privé (Tailscale compris). Une autre adresse est refusée.
- Ce réglage ne se change que dans le fichier ou l'environnement : l'API `/api/config` le refuse, pour qu'aucune session ne puisse détourner les conversations.
- Ce qui part au service : les mêmes tours que la mémoire d'OpenMausBot capture déjà (tes chats 1:1, pas les routines, webhooks, tours internes ni messages d'autres bots ; les salons seulement avec **Learn from group chats**). Un bot avec **Let this bot use memory** coupé n'envoie ni ne reçoit rien.
- Avant chaque tour, les passages pertinents arrivent dans le bloc « Recalled » (étiquette `long-term memory · …`) ; les faits « noyau » vont dans le prompt système du bot.
- Si le service est arrêté, les tours attendent en mémoire (500 max) et repartent quand il revient ; le rappel est simplement sauté, sans bloquer le tour.

## Ajouter les outils MCP à un bot

Installe les dépendances une fois sur la machine d'OpenMausBot (`npm ci` dans ce dossier), puis une entrée **par bot** dans `config.json` → `mcpServers` :

```json
{
  "mcpServers": {
    "memoire-scout": {
      "command": "node",
      "args": ["/chemin/vers/plugins/maus-memory/src/mcp.ts"],
      "env": {
        "MAUS_DATABASE_URL": "postgres://maus:MOT_DE_PASSE@127.0.0.1:5433/maus",
        "MAUS_MEMORY_BOT_ID": "id-du-bot-scout",
        "MAUS_EMBEDDINGS": "ollama",
        "MAUS_EMBEDDINGS_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

L'id du bot est dans l'URL de ses réglages (ou `GET /api/bots`). Dans **Bot settings → Access**, donne à chaque bot uniquement **son** serveur `memoire-…` : un bot réglé sur « tous les serveurs MCP » verrait aussi ceux des autres.

| Outil | Rôle |
| --- | --- |
| `memory_search` | Recherche hybride ; `asOf` pour remonter dans le temps |
| `memory_list` | Ce que le bot sait (noyau d'abord) |
| `memory_add` | Ajouter un fait (+ entités et relations) |
| `memory_update` | Remplacer un fait qui a changé (l'ancien reste dans l'historique) |
| `memory_forget` | Effacer pour de bon, par id ou par mots ; ces mots ne seront plus réappris |
| `memory_history` | L'évolution d'un fait |
| `memory_graph` | Les liens autour d'une personne, d'un client, d'une machine |

## API HTTP

Toutes les routes sauf `/healthz` demandent `Authorization: Bearer $MAUS_MEMORY_TOKEN`.

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `POST` | `/v1/turns` | Un tour terminé (OpenMausBot l'envoie tout seul) |
| `POST` | `/v1/recall` | `{ botId, message }` → `{ core, passages }` |
| `POST` | `/v1/search` | `{ botId, query, asOf?, limit? }` |
| `GET` | `/v1/bots/:id/status` | Curseur, tours en attente, dernier dream |
| `GET` / `POST` | `/v1/bots/:id/facts` | Lister (`?asOf=`, `?core=`) / ajouter |
| `POST` | `/v1/bots/:id/facts/:factId/replace` | Remplacer un fait |
| `GET` | `/v1/bots/:id/facts/:factId/history` | Historique |
| `POST` | `/v1/bots/:id/forget` | `{ factId }` ou `{ words }` |
| `POST` | `/v1/bots/:id/dream` | Dream immédiat |
| `PUT` | `/v1/bots/:id/criteria` | Tes propres règles de tri pour ce bot (`null` = défaut) |
| `DELETE` | `/v1/bots/:id` | Tout effacer pour ce bot |

## Garde-fous

- Un fait du dream doit citer tes propres mots dans le tour qu'il cite ; chaque nombre, chemin et URL du fait doit venir de ces citations. Les entités que tu n'as pas nommées sont écartées.
- Tout ce qui ressemble à un secret (mot de passe, clé, jeton) est refusé, par le dream comme par les outils.
- Dans un salon, ce que disent les autres ne devient jamais un fait sur toi ni un fait « noyau ».
- `forget` efface le fait, son historique, ses relations et les nœuds du graphe devenus orphelins.
- Chaque bot a sa partition (`bot_id`) ; aucune requête ne lit celle d'un autre.

## Développer

```sh
npm ci
npm run typecheck
MAUS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test   # serveur avec pgvector + AGE préchargé
```

Chaque fichier de test crée puis supprime sa propre base. Pour un serveur de test : l'image `docker/postgres` (`docker run -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust <image>`).

## Limites connues

- Les faits « noyau » arrivent dans le prompt système au tour suivant la recherche qui les a lus (ils sont préchargés au démarrage d'OpenMausBot).
- L'isolation des outils MCP entre bots repose sur la sélection par bot dans **Access**.
- La qualité du tri dépend du modèle du dream ; les tests utilisent un modèle simulé.
- Les relations du graphe utilisées par la recherche sont celles d'aujourd'hui ; `asOf` remonte le temps sur les faits, pas sur les chemins du graphe.
