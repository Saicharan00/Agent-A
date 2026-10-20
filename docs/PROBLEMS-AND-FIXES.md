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

## 2. Your browser cannot open an app a bot started (e.g. `http://127.0.0.1:8501`)

**Setup:** A and B.

**What you see:** A bot starts a web app (Streamlit, a dev server, ...) on a port such as `8501` and says it is
running, but `http://127.0.0.1:8501` does not load in the browser on your computer.

**Why:** Each bot has its own computer (a container). `127.0.0.1` inside it means that container only, not your
computer. The app should stay bound to `127.0.0.1`; changing it to `0.0.0.0` to reach it is a security change.

**Fix:** Use the bot's own browser. Open the bot → **Computer** → **Desktop**, and go to `http://127.0.0.1:8501` in the
Chromium window there. You can click and type in it from the Desktop tab. Or ask the bot to start the app and open it
in its desktop browser for you.

## 3. Copying text from a bot's terminal into a chat

**Setup:** A and B.

**What you see:** Pressing **Ctrl+C** in the bot's **Computer → Terminal** does not copy. It stops the program running
there (for example `make run-app`). **Ctrl+Shift+C** opens Chrome's developer tools instead.

**Why:** The terminal sends Ctrl+C to the shell, like any real terminal.

**Fix:** Select the text with the mouse, right-click it → **Copy**, then **Ctrl+V** in the chat box. For long output,
ask the bot to paste it into the chat itself, e.g. "@Backend Engineer run `make test` and paste the last 30 lines here".
