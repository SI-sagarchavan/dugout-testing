# 06 · Screenshot on a comment

Status: ready-for-agent
Type: task

## What

A comment carries the element as the person saw it (`ui_comments.context`: type, props, parent, children), but no picture of it. The router (03) and `ui-editor` can't see what "too cramped" or "wrong colour" looks like.

## Fix

- Studio crops the element, with some space around it, when the comment is sent.
- The backend stores the image as an artifact and keeps only its reference on the comment.
- `ui.load` names the reference, and a tool such as `ui.look` shows the picture to the model when it asks.
- It never goes into the comment's JSON or the model's context as text.

## Done when

- A sent comment has a screenshot reference, and `ui.look` returns the picture for it.
- A comment without one still works.
