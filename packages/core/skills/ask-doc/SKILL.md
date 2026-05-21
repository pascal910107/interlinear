---
name: ask-doc
description: Answer pending document-level questions from the interlinear DocChat sidebar. Use when the user asks to "answer the questions", "reply to docchat", "answer doc questions", or references unanswered entries in .interlinear/conversation.json.
---

# Answer document Q&A

The interlinear DocChat sidebar lets the user ask free-form questions
about the whole translated document — not bound to any particular JSX
element. Each question is persisted as an entry in the workspace's
`.interlinear/conversation.json` file with `answer: null`.

Your job: read the unanswered entries, ground your answers in the actual
content of `pages/*/index.tsx`, and write each answer back into the
conversation file.

## Conversation store

Path: `apps/demo/docs/<docId>/.interlinear/conversation.json`. Schema:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "q-xxxxxxxx",
      "askedAt": "<ISO>",
      "question": "...",
      "answer": null,
      "answeredAt": null
    }
  ]
}
```

Each doc under `apps/demo/docs/` has its own conversation store. Locate
files by globbing `apps/demo/docs/*/.interlinear/conversation.json`. If
multiple have pending entries, answer them all unless the user narrowed
the scope to one doc.

## Procedure

1. **Find the file(s).**
   - `Glob` for `apps/demo/docs/*/.interlinear/conversation.json`.
   - For each store, read it and parse JSON.
   - Filter to entries where `answer === null`. If none, tell the user
     which docs had pending entries (or that none did) and stop.

2. **Ground each answer in the document.**
   - The content for doc `<docId>` lives in
     `apps/demo/docs/<docId>/pages/*/index.tsx`.
   - For a short document (≤ ~30 pages), `Read` every page once at the
     start and keep them in working memory.
   - For a longer document, `Grep` the question's key terms across
     `apps/demo/docs/<docId>/pages/**/index.tsx` first to locate relevant
     pages, then `Read` only those.
   - The translated text lives in JSXText nodes — `className`, `style`,
     and `EXAMPLE_CODE`-style constants are layout, not content. Skim
     past those.

3. **Write the answer.**
   - 1–4 short paragraphs, in the document's locale where natural
     (e.g. zh-Hant for the demo).
   - **Cite pages** when the answer comes from specific pages —
     conventionally `(see page-0042)` or `(page-0042: 標題)`. The
     sidebar surfaces these as clickable references in a later iteration;
     for now they're just informative.
   - If the question is about the document but you genuinely can't find
     an answer in the pages, say so — don't make one up.
   - If the question is off-topic (chat-bot style "what's the weather"),
     reply briefly that DocChat is scoped to the translated document.

4. **Write the answer back into the JSON file directly.**
   - Use the `Edit` tool on `.interlinear/conversation.json`. For each
     entry you're answering, set `answer` to your text and `answeredAt`
     to the current ISO timestamp; leave `id`, `askedAt`, and `question`
     untouched.
   - The dev server has a chokidar watcher on this file, so if the
     sidebar is open it picks up your write within milliseconds and
     re-renders the answer — no server roundtrip, no curl, no port
     discovery needed.
   - JSON must stay valid. If you're using `Edit`, do one entry at a
     time so a malformed edit can't corrupt the whole file. If you'd
     rather rewrite the whole file, parse the JSON, mutate the entry
     objects in memory, and `Write` it back with `JSON.stringify(store, null, 2)`.

5. **Report.**
   - Summarise: `N answered, 0 pending` plus one line per question
     (`q-abc12345: "what does strict do?" → ... (see page-0001)`).

## Do not

- Do not touch `pages/*` while answering — answers go in the conversation
  file, not in the translated source. (Use `apply-comments` if the user
  asks you to edit translations.)
- Do not invent page citations. Only cite pages you actually read.
- Do not overwrite existing answers. If `answer !== null`, skip the entry.
- Do not add new entries — only the sidebar UI creates questions.
