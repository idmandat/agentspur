# agentspur

**Your agent changed something. agentspur knows what, and brings it back.**

A small command-line tool that records every file change in a folder while an AI agent (Claude Code, Codex, Cursor, Aider, whatever you run) is working in it. Afterwards you can see the timeline, look at any single change, and rewind to any point.

- No account, no cloud, nothing leaves your machine
- No dependencies, one file folder (`.agentspur/`) inside your project
- Works with any agent, because it never talks to the agent. It only watches the folder.
- Node 20 or newer, on macOS, Linux and Windows

```
npx github:idmandat/agentspur watch
```

That is all. Leave it running in a terminal while the agent works. (It installs straight from this repository; once it is on npm the command shortens to `npx agentspur watch`.)

## What it looks like

```
$ npx github:idmandat/agentspur watch
agentspur is watching /Users/me/shop
212 files remembered as the starting point.
Stop with Ctrl+C. Timeline: agentspur log

#   2  14:02:11  change  src/checkout.js  4.1 KB -> 5.3 KB
#   3  14:02:11  add     src/checkout.test.js  1.2 KB
#   4  14:03:40  delete  public/images/hero.png  was 812 KB
#   5  14:03:41  change  package.json  1.0 KB -> 1.1 KB
```

Something went wrong at step 4?

```
$ npx github:idmandat/agentspur back 4
Going back to before step #4 would:
  recreate public/images/hero.png
  restore  package.json
Do it? This is recorded too, so you can come back. [y/N] y
Done. 2 file(s) returned to how they were before step #4.
Recorded as steps #6–#7. To undo the undo: agentspur back 6
```

## Commands

| Command | What it does |
|---|---|
| `agentspur watch` | Start recording in the current folder. Leave it running. |
| `agentspur log` | Show the timeline (last 40 steps; `--all` for everything). |
| `agentspur diff <step>` | Show what changed in that step, as a line diff. |
| `agentspur show <step>` | Print the file as it was right after that step. |
| `agentspur back <step>` | Return every file to how it was **before** that step. Asks first. `--yes` skips the question. |
| `agentspur back 14:02` | Return to how things were at that time today. |
| `agentspur status` | How many files are watched, how many steps, how much space. |

Rewinding is itself recorded as steps, so you can always rewind the rewind.

## How it works

- On the first `watch`, agentspur remembers every file in the folder as the starting point.
- While it runs, every added, changed or deleted file is written to the timeline (`.agentspur/log.jsonl`), and a copy of the file content is kept (`.agentspur/objects/`, one copy per distinct content, so unchanged files cost nothing).
- If you start `watch` again later, changes made in between are recorded too, marked "while agentspur was not running".
- `back` compares the current folder with the state before the chosen step and only touches files that differ.

## Doesn't my agent have undo already?

Some do. Claude Code has checkpoints, Cursor has them, others are adding them. They are good, and they have three limits: each one sees only its own edits, each one forgets when the session ends, and each one belongs to that tool. agentspur sees the whole folder no matter who changed it (two agents, a script, you), keeps the timeline until you delete it, and stays when you switch tools.

## What it does not do

- It does not know **which** agent made a change, or whether it was you. It sees the folder, not the process. That is the price for working with every agent and not breaking when they update.
- It is not a replacement for git. Git remembers what you commit. agentspur remembers everything in between.
- Files larger than 20 MB are recorded as changed, but no copy is kept, so they cannot be restored.
- `.git`, `node_modules`, `.agentspur` and OS junk files are always ignored. Add your own patterns to `.agentspurignore` in the folder (one glob per line, like `*.log` or `build/`).

To remove agentspur from a project, delete the `.agentspur/` folder. Nothing else was touched.

## Install for good

```
npm install -g github:idmandat/agentspur
agentspur watch
```

After that every command is just `agentspur ...`.

## Why this exists

We run [ID MANDAT](https://idmandat.com), an open register where companies state which AI agents act for them and what those agents may do. That is the question from the outside: *who is this agent, and is it allowed to do this?* agentspur is the same question from the inside: *what did the agent just do on my machine, and can I take it back?*

Built by Claude together with ID MANDAT. MIT licensed. Questions and bugs: open an issue, we read them every day.

---

*Deutsch:* agentspur zeichnet auf, was KI-Agenten in einem Ordner ändern, und kann jede Änderung zurückholen. Kein Konto, keine Cloud, keine Abhängigkeiten. `npx github:idmandat/agentspur watch` startet die Aufzeichnung, `agentspur log` zeigt die Zeitleiste, `agentspur back <Schritt>` spult zurück. Ein Werkzeug von [ID MANDAT](https://idmandat.com), gebaut zusammen mit Claude.
