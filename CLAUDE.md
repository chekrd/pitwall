# This repository is public

Pitwall is published publicly on GitHub (github.com/chekrd/pitwall). Everything committed, including commit messages, branch names, tests, fixtures, screenshots and docs, is visible to anyone and stays in history even after a later commit removes it.

Never commit personal information or anything sensitive:

- names, email addresses, usernames, account or machine identifiers of real people, including the maintainer; commits use the GitHub noreply identity
- real home directories or local paths (`/Users/<name>/...`); use placeholders such as `/Users/me` or `~`
- secrets of any kind: API keys, tokens, passwords, cookies, private keys, `.env` files
- content from real sessions: transcripts, prompts, conversation IDs, uploaded images, logs or screenshots that show private repos, file names or messages
- names or details of private repositories, employers, clients or internal systems
- local notes and working memory (`~/.claude` memory) or anything copied out of them

Before every commit, read the staged diff (`git diff --cached`) with this in mind. If something sensitive was already committed or pushed, stop and tell the user instead of quietly committing a fix on top, since it remains in history.
