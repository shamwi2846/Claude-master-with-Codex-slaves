# Reusable prompt: "GPT rates it 10/10"

Paste the text between the lines into a Claude chat that's open in the project. Fill in the three `<...>` parts; delete any you don't need.

---

**Goal: improve this project until GPT rates it 10/10 in every area. Keep going until the goal is reached; don't stop to ask me in between.**

Project: `<what it is and where it lives, e.g. "my MT5 EA in C:\...\GoldBot">`
What matters most to me: `<e.g. correctness of the trading logic, no false alarms, easy to restore>`
Areas to score (adjust if needed): engineering quality · correctness & reliability · efficiency per dollar · usefulness of results · usability · safety · `<domain area, e.g. MQL5/trading value>` · portability & recovery.

How to run it:
1. **Write the scoring prompt for GPT.** Save it as `gpt-goal-prompt.md` in the project. It must:
   - list the real files GPT should read,
   - state my priorities,
   - ask for a 1–10 score per area with a one-line reason,
   - define 10 as "no realistic improvement left that's worth its cost",
   - ask for up to 10 concrete changes ranked by value for cost, plus what NOT to do,
   - include a **"Decided"** list: things we deliberately accepted, which GPT must not re-raise without new evidence.
2. **Each round:** run it with `gpt.js idea` (xhigh). Tell GPT the previous scores and exactly what changed since. Ask it to verify by reading the files, and to run no tests.
3. **Between rounds, you decide.** You have full control over the final decisions and changes:
   - apply what's worth it, and fix it properly,
   - reject the rest with a one-line reason and add it to the "Decided" list,
   - test every change you make and keep a regression set that re-runs each round,
   - keep backups in sync if the project has them.
4. **Efficiency:** GPT usage isn't the main concern, but get the most value per dollar. Use one GPT call per round. Don't do full audits when the diff is enough, and don't add machinery that doesn't pay for itself.
5. **When to stop:**
   - **Success:** every area is 10/10.
   - **Converged:** for 2 rounds in a row, everything GPT still asks for is something you've rejected with a reason.

   If 10/10 is never reached, stop at the converged point and tell me which areas aren't 10 and why.
6. **Report briefly at the end:**
   - a table of scores per round,
   - the main changes,
   - what you rejected and why,
   - test status,
   - roughly what the GPT rounds cost.

---

## Tips
- **Requirements:** this needs the Claude + GPT setup (`~/.claude/gpt/gpt.js`). It's already global, so it works in every project.
- **Big projects:** narrow the file list or the areas, otherwise each GPT round reads a lot. Roughly 100k GPT tokens and 3 minutes per round is normal.
- **Quick check:** for an assessment without changes, replace step 3 with "report only, change nothing".
