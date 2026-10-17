# Third-party code: XActions HTTP client

This directory contains **unmodified copies** of a subset of files from
[XActions](https://github.com/nirholas/XActions) by nirholas, licensed under the
**Apache License, Version 2.0** (see `LICENSE` in this directory).

- Upstream: https://github.com/nirholas/XActions
- Upstream commit copied: `b9c4bf7` (package version 3.5.0)
- Files (relative to upstream `src/`), the minimal import closure of the HTTP client
  `scrapers/twitter/http/{client,auth,actions,engagement,dm,profile}.js`:
  - `scrapers/twitter/http/`: `actions.js` `auth.js` `client.js` `dm.js` `endpoints.js` `engagement.js`
    `errors.js` `guest.js` `profile.js` `queryIds.js` `transactionId.js` `x-endpoints.generated.js` `parse/user.js`
  - `client/api/dmConversation.js`, `client/auth/userAgents.generated.js`, `utils/http2.js`
- Changes made: **none to file contents.** Only the files above were copied (the rest of the upstream repository,
  including its browser/Puppeteer tooling, was left out), and `package.json` here only marks the folder as ES modules.
- Ariana's own sign-in (`social/x_login.js`) does not use upstream's `auth.js` login; only its authenticated API calls,
  query-ID discovery and request signing are used.
- To update: re-copy the same files from a newer upstream commit, update the commit above, and run `npm test`.
