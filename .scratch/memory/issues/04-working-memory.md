# 04 · Working memory: compaction and notes

Status: ready-for-agent
Type: task

Overlaps harness issue 05 (context for long runs); this ticket covers the transcript, 05 covers images and the shared prefix.

## What

- **Compaction.** When the transcript sent to the model passes a share of the tier's context window, older turns are replaced in the request by one summary written by the fast model, and the most recent turns are sent as they are. The saved transcript keeps everything; the summary is saved as a transcript entry so a resumed run sends the same request.
- **Notes.** The agent has a small notes block (a character limit, plain text) it rewrites with `notes.write`. It is kept in the checkpoint and sent after the cached prefix on every call, so it survives compaction.
- **Warning.** One turn before compaction, the agent is told it will happen so it can save what matters to its notes.
- **Claude thinking.** Claude 5.5 binds reasoning to an unedited history. Compaction must start the compacted request at a point that sends no reasoning blocks from before it; verify on Bedrock before enabling compaction for Claude models.

## Done when

- In a scripted run of many tool rounds, the request stays under the threshold, the summary and notes are present, and the saved transcript has every round.
- A run resumed after compaction sends the same request it would have sent without the restart.
