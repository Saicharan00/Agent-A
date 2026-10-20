# Problems and fixes

Problems hit while building real projects with Agent A, and how they were solved. Example project: an AI data
analyst that takes a business question in plain English, breaks it down, digs through the data, double-checks its
numbers and claims, and answers with a chart.

Each entry: what you see, why it happens, what to do.

---

## 1. A bot asks for access to `pypi.org` and `files.pythonhosted.org`

**Setup:** B (Docker Sandbox, `sbx`).

**What you see:** A bot says it cannot install Python packages (`pip install` / `uv` fails or hangs) and asks you to
allow `pypi.org` and `files.pythonhosted.org`.

**Why:** The sandbox blocks every domain that is not on its network policy. The app has no network setting of its
own, and the sandbox cannot change its own policy.

**Fix:** In a terminal **outside the sandbox** (PowerShell on Windows, Terminal on macOS), run:

```bash
sbx policy allow network --sandbox agent-a pypi.org,files.pythonhosted.org
```

Use the same command for any other site a bot asks for, with that site's domains. No restart is needed. If you get
"Approval required" instead, run `sbx policy approval ls` and approve the pending request.

Setup A (native Linux / WSL2) has no sandbox firewall, so this does not happen there.
