# Graph Report - dashboard  (2026-06-04)

## Corpus Check
- 14 files · ~72,531 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 197 nodes · 223 edges · 16 communities (9 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `500d83b2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]

## God Nodes (most connected - your core abstractions)
1. `runPodcastJob()` - 6 edges
2. `getSpotifyTokens()` - 5 edges
3. `saveSpotifyTokens()` - 5 edges
4. `vaultEncrypt()` - 4 edges
5. `vaultDecrypt()` - 4 edges
6. `spDbGet()` - 4 edges
7. `refreshSpotifyToken()` - 4 edges
8. `getDriveAccessToken()` - 4 edges
9. `userVaultKey()` - 3 edges
10. `spotifyFetch()` - 3 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities (16 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (90): ALLOWED, app, APP_SLUGS, areas, b, bcrypt, body, chat (+82 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (21): app, date, { execFile }, { execSync, exec }, express, fs, fsExtra, { GoogleGenerativeAI } (+13 more)

### Community 2 - "Community 2"
Cohesion: 0.16
Nodes (14): { buildLatexDocument, summarizeWithGemini, parseMultipart }, date, latexDoc, path, buildLatexDocument(), Busboy, { GoogleGenerativeAI }, parseMultipart() (+6 more)

### Community 3 - "Community 3"
Cohesion: 0.25
Nodes (11): getAudioSettings(), getSpotifyTokens(), refreshSpotifyToken(), saveSpotifyTokens(), spDbGet(), spDbRun(), spotifyFetch(), update (+3 more)

### Community 4 - "Community 4"
Cohesion: 0.25
Nodes (9): driveGetOrCreateFolder(), driveUploadFile(), getDriveAccessToken(), getOAuth2Client(), getSecret(), getVideoDurationSec(), podcastDbSet(), runFFmpeg() (+1 more)

### Community 5 - "Community 5"
Cohesion: 0.33
Nodes (5): ext, fs, http, MIME, path

### Community 7 - "Community 7"
Cohesion: 0.67
Nodes (3): checkAdmin(), checkAuth(), status

### Community 8 - "Community 8"
Cohesion: 0.67
Nodes (3): compileLaTeX(), findLatexCompiler(), runLatexCompiler()

## Knowledge Gaps
- **131 isolated node(s):** `express`, `{ execFile, exec, spawn }`, `fs`, `os`, `path` (+126 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `express`, `{ execFile, exec, spawn }`, `fs` to the rest of the system?**
  _131 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._