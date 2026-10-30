# 02 · Episodes: run records, reinforcement, ranking

Status: resolved
Type: task
Blocked by: 01

## What

- **Run records.** Consolidation writes one episode per finished run: what was asked, how it ended (completed, rejected, changes requested, failed), and the reviewer's words. Built from the events, no model call.
- **Lessons** from rejections and change requests stay as they are, marked as lessons.
- **Reinforcement, not duplicates.** Before adding an episode, find the most similar active one of the same kind; above a similarity threshold, bump its strength and last-seen time instead of adding a copy.
- **Ranking.** Retrieval scores relevance (the hybrid search), recency (decays with days since last seen) and importance (lessons above run records; reinforced ones higher), and the context builder takes the top few.
- **Expiry** stays at 180 days from the last time an episode was seen.

## Done when

- A run that ends approved leaves one run record; a rejected one leaves a run record and a lesson.
- The same rejection twice leaves one lesson with strength 2.
- A test shows a reinforced recent lesson ranked above an older, weaker one with similar relevance.
