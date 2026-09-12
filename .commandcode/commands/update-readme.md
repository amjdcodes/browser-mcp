---
description: Reads the full project, then creates or upgrades README.md to a professional standard automatically
---

You are a professional technical writer. Your task is to produce a world-class `README.md` for this project.

Follow these phases in strict order. Do not skip any step. Do not ask for confirmation. Just execute.

---

## PHASE 1 — MAP THE FULL PROJECT (MANDATORY)

Run these commands to understand the project completely:

```bash
# Full project tree
find . -maxdepth 4 \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*'

# List root files
ls -la
```

Then read ALL of these files if they exist (read every single one, do not skip):

**Project metadata:**
- `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `pom.xml`
- `requirements.txt` / `requirements-dev.txt`
- `setup.py` / `setup.cfg`
- `LICENSE` / `LICENSE.md` / `LICENSE.txt`

**Configuration:**
- `.env.example` / `.env.sample` / `.env.template`
- `config.py` / `config.ts` / `config.yaml` / `settings.py`

**Infrastructure:**
- `Dockerfile` / `docker-compose.yml` / `docker-compose.yaml`
- `Makefile` / `justfile`
- `.github/workflows/*.yml` (CI/CD pipelines)

**API and Schema:**
- `openapi.json` / `openapi.yaml` / `swagger.json`
- All router files: `routers/` / `routes/` / `api/`
- All model files: `models/` / `schemas/`

**Main source code:**
- Entry points: `main.py` / `app.py` / `server.py` / `index.ts` / `main.go`
- All files inside: `src/` / `app/` / `lib/` / `pkg/` / `internal/`
- Core services: `services/` / `core/` / `utils/`

**Existing documentation:**
- `README.md` (if it exists — read it carefully)
- `CHANGELOG.md` / `CONTRIBUTING.md`
- Any `.md` files in `docs/`

After reading everything, extract and memorize:
- Exact project name
- Exact language version and framework
- Exact license type
- All features (from actual source code only)
- All environment variables (from .env.example only)
- All API endpoints (from router files only)
- Architecture pattern (layered? microservices? monolith?)
- External services and APIs it integrates with
- How to install, configure, and run it

---

## PHASE 2 — DECIDE: CREATE OR UPDATE?

### Case A — README.md does NOT exist

Go directly to Phase 3. Create a full README from scratch.

### Case B — README.md EXISTS

Evaluate it against these criteria and score each:

| Criterion | Score 0 | Score 1 |
|-----------|---------|---------|
| Description | Vague or missing | Specific, 1–2 sentences |
| Installation | Incomplete | Step-by-step, copy-pasteable |
| Configuration | Missing env vars | All vars documented |
| Architecture | No explanation | Diagram + table |
| API docs | Missing or wrong | All endpoints with examples |
| Code examples | None | Real, runnable examples |
| Badges | None | Accurate badges |
| Completeness | Missing sections | All relevant sections present |

Decision:
- Score 0–5 → Full rewrite (preserve any correct information)
- Score 6–7 → Targeted upgrade (keep structure, fill all gaps)
- Score 8   → Minor polish only (fix inaccuracies, add missing details)

State your decision and score before proceeding to Phase 3.

---

## PHASE 3 — WRITE README.md

Produce the complete file using this structure. Only include sections that genuinely apply to this project. Never include empty sections or placeholder text.

---

TEMPLATE:

<!-- BADGES: Only include badges that are 100% accurate for this project -->
![Language](https://img.shields.io/badge/Language-Version-color?logo=name)
![Framework](https://img.shields.io/badge/Framework-latest-color?logo=name)
![License](https://img.shields.io/badge/License-TYPE-yellow)

# Project Name

> One sentence. What it does. For whom. No fluff.

[What It Does](#what-it-does) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Configuration](#configuration) · [API Reference](#api-reference) · [Deployment](#deployment) · [Contributing](#contributing)

---

## What It Does

Write 2–4 paragraphs answering:
- What problem does this solve?
- How does it solve it?
- Who should use it?
- What makes it different?

---

## Key Features

- Feature Name — Specific description pulled from source code
- Feature Name — Specific description pulled from source code
- Feature Name — Specific description pulled from source code

---

## Architecture

Brief description of the architectural approach (1–2 sentences).

ASCII diagram showing layers and components, for example:

  ┌─────────────────────────────────┐
  │         Interface Layer         │
  │   FastAPI Routers · Telegram    │
  └────────────────┬────────────────┘
                   ▼
  ┌─────────────────────────────────┐
  │      Orchestration Layer        │
  │  Pipeline · Scheduler · State   │
  └────────────────┬────────────────┘
                   ▼
  ┌─────────────────────────────────┐
  │         Service Layer           │
  │  AI · TTS · Video · Upload      │
  └────────────────┬────────────────┘
                   ▼
  ┌─────────────────────────────────┐
  │      Infrastructure Layer       │
  │   SQLite · Filesystem · APIs    │
  └─────────────────────────────────┘

### Layer Responsibilities

| Layer | Responsibility | Key Components |
|-------|---------------|----------------|
| Interface | Receives requests, sends notifications | Routers, Bot, Scheduler |
| Orchestration | Coordinates workflows, enforces state | Pipeline, Coordinator |
| Service | Business logic and external I/O | AI, TTS, Video, Upload |
| Infrastructure | Durable storage and filesystem | SQLite, temp/, output/ |

---

## Project Structure

```
project-root/
├── src/                    # Main source code
│   ├── services/           # External integrations
│   ├── models/             # Data models
│   └── routers/            # API endpoints
├── tests/                  # Test suite
├── .env.example            # Environment template
├── Dockerfile              # Container definition
└── README.md
```

---

## Quick Start

### Prerequisites

- Runtime: e.g. Python 3.11+, Node.js 18+, Go 1.21+
- System deps: e.g. FFmpeg, Redis
- API keys: list every external service required

### Installation

```bash
# 1. Clone
git clone https://github.com/user/repo.git
cd repo

# 2. Environment setup
python -m venv .venv && source .venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Configure
cp .env.example .env
# Edit .env with your values

# 5. Run
python main.py
```

---

## Configuration

Copy `.env.example` to `.env` and fill in all required values.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAR_NAME` | Yes | — | What it does, where to get it |
| `VAR_NAME` | No | value | What it does |

Document every single variable found in `.env.example`. Do not skip any.

---

## API Reference

Base URL: `http://localhost:PORT`
Auth: `Authorization: Bearer <token>`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/resource` | Create resource |

### Examples

Example — trigger a job:
```bash
export TOKEN=your_token_here

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/jobs/run-now
```

---

## Deployment

### Docker

```bash
docker build -t project-name .
docker run -p 8000:8000 --env-file .env project-name
```

### Docker Compose

```bash
docker compose up -d
```

### Systemd

```bash
sudo cp deploy/project.service /etc/systemd/system/
sudo systemctl enable --now project
sudo journalctl -u project -f
```

---

## Testing and Quality

```bash
# Run all tests
pytest tests/ -v

# With coverage
pytest tests/ --cov=src --cov-report=html

# Lint
ruff check src/ && ruff format src/
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Symptom description | Root cause | Exact fix |

---

## License

This project is licensed under the [LICENSE_TYPE License](LICENSE).

---

## Contributing

Contributions are welcome. Before opening a pull request:

1. Run the linter and fix all warnings
2. Run all tests and ensure they pass
3. Keep optional dependencies lazy-imported
4. Follow the existing architectural patterns
5. Never commit `.env` or any credentials

---

END OF TEMPLATE

---

## PHASE 4 — SELF-REVIEW BEFORE SAVING

Check every item. Fix failures before writing the file:

- [ ] Project name matches exactly what is in the config file
- [ ] Description is specific — no vague words like "powerful" or "robust"
- [ ] Badges are accurate (correct language version, real license)
- [ ] Every install step is copy-pasteable and in correct order
- [ ] Every variable in `.env.example` appears in the Configuration table
- [ ] API endpoints match the actual router files — no invented routes
- [ ] Architecture matches the actual code structure
- [ ] No placeholder text remains — no "your project", "TODO", "example.com"
- [ ] No fabricated features — only what was confirmed in source code
- [ ] All code blocks have correct language tags

---

## PHASE 5 — SAVE AND REPORT

1. Write the final content to `README.md` in the project root (overwrite if exists)
2. Print this summary:

Action taken: Created / Updated / Polished
Score (if updated): X / 8
Sections added: list
Sections improved: list
Information that was missing: anything not found in source
Recommended follow-up: what the developer should manually check

