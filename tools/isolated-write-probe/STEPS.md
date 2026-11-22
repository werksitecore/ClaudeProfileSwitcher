# Write-pattern probe: steps (about 10 minutes)

Use a **test account**, not one of your working accounts. Two windows are open:
- **PROBE WATCHER:** type each step's name here and press Enter **before** doing that step.
- **ISOLATED CLAUDE PROBE:** the Claude CLI.

| # | In PROBE WATCHER, type | In ISOLATED CLAUDE PROBE, do |
|---|---|---|
| 1 | `login` | Sign in with the test account when Claude asks. Trust the folder if asked. |
| 2 | `turn` | Send: `Remember the word PELICAN-42. Reply with one short sentence.` |
| 3 | `edit-file` | Send: `Append the line "line two" to probe.txt.` Approve the edit. |
| 4 | `turn2` | Send: `What word did I ask you to remember?` |
| 5 | `title` | Run `/rename probe-session` (skip it if the command doesn't exist). |
| 6 | `rewind` | Run `/rewind`, choose the point before the probe.txt edit, and restore code and conversation. |
| 7 | `fork-edit` | Press Esc twice, pick an earlier message, edit it, and send. Skip this if the option isn't available. |
| 8 | `compact` | Run `/compact`. |
| 9 | `exit` | Type `/exit`. |
| 10 | `resume` | In the same window, run `claude --resume`, pick the session, and send `Still there?`. Then `/exit`. |
| 11 | `image` | Optional: start `claude`, paste a small image, ask what it shows, then `/exit`. |

When you're done, close both windows and tell Claude Code "probe done". The log is in
`.isolated-write-probe\write-pattern.jsonl`. It contains file names, sizes and file IDs only, never conversation
text. Claude's cleanup sweep is tested afterwards without you; it needs no new sign-in.
