# Agent A — 15-minute demo

A guided first run with the **real engines**. You give Agent A a small goal, watch it plan and delegate, approve a
step, read the report, learn from it, and take a carry-over brief away.

**Cost:** one small goal is roughly 6–12 engine runs across Claude Code and Codex. To keep it small, the goal below
has a run budget.

## Before you start (2 min)

- [ ] The app runs: `pnpm launch` (or `scripts\windows\AgentA.cmd` in the sandbox setup), then open http://localhost:3000.
- [ ] `pnpm run doctor` is all green, or only warns. Settings → Engines shows Claude **and** Codex as *configured*.
      If not, see README → Sign the bots in.
- [ ] The team exists: the sidebar lists Agent A, Architect, ML Engineer, Data Engineer, Backend Engineer, MLOps
      Engineer and QA & Security. If not, the Home wizard has **Create the team**.

## 1. Give Agent A a goal (2 min)

1. Go to **Home**. In **New goal**, paste:

   > Write a one-page design note at /shared/notes/url-shortener.md for a tiny URL-shortener service: API (create,
   > resolve), storage choice with one rejected alternative, and three test cases. Have the Backend Engineer draft
   > the API and the QA & Security bot add the tests. **Ask for my approval before saving the final file to
   > /shared.** Keep it under 8 runs.

2. Click **Start goal**. Agent A answers in the goal thread with a plan: tasks, owners and why each owner.
3. Read the plan. A strong lead names owners, order and a definition of done for each task. Then click
   **Confirm plan**.

## 2. Watch the delegation (4 min)

- The **goal bar** at the top of the thread shows progress and runs used against the budget.
- **Tasks** (sidebar) shows the cards moving through *todo → in progress → review → done*.
- Click the **Backend Engineer** in the sidebar, then **Computer**. Watch its **Terminal**, **Files** and **Runs**
  tabs while it works. The tool cards in the chat show each command it ran.
- Notice when Agent A **sends work back**. Reviewing and asking for a fix is the lead's main job.

## 3. Approve (1 min)

When a bot is ready to save the final file, Home shows **Waiting for your approval**, and the bell (Notifications)
lights up. Read what it asks to do and why. Click **Approve**, or **Deny** with a note to see it change course.

## 4. Review the report (2 min)

When the goal bar says **Done**, the thread ends with the **Goal report**: what was delivered, decisions, open
risks and run usage.

- Open `/shared/notes/url-shortener.md` from any bot's **Files** tab (`/shared` is the team share).
- Use **Export** on the goal bar to download the report as Markdown.
- Not happy? Reply in the thread ("tighten the storage section") and Agent A delegates the fix.

## 5. Learn from it (3 min)

Open **Learn**:

- **Decisions**: the design decisions Agent A recorded (ADRs), with the rejected alternative and why.
- **Lessons**: short lessons from this goal. Answer the ones due today; they come back spaced out.
- **Work split**: how much the bots did versus you this week (the target is that bots do 80%).
- Optional: **Weekly review** asks Agent A for a short review of your week and adds 5 review questions.

## 6. Take a carry-over brief (1 min)

Learn → **Briefs** → pick the goal under *Brief source* → **Ask Agent A for a brief**. Agent A writes a short,
sanitized how-to (what to do, steps, checks, risks) that you can reuse elsewhere. It is checked for secrets and
confidential terms before it is saved. Open it and copy it.

## Done? Note the result

Write one line on anything that confused you or broke, and open an issue with it if you like.

**If something fails:** `pnpm run doctor`, then README → Troubleshooting. A run that ends as *limited* hit your
subscription window. It resumes by itself after the reset time shown on the **Usage** page.
