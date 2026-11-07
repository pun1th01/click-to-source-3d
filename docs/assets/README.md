# /docs/assets

Images used by the README.

The `inspector-*.png` screenshots are taken from the example app by
`e2e/screenshots.spec.ts`, so they show the real inspector. To refresh them:

    CTS_SCREENSHOTS=1 CTS_E2E_CHANNEL=msedge npx playwright test screenshots

Those are `inspector-panel`, `-hover`, `-instance`, `-preview`, `-compare` and
`-agent`. The last connects a real MCP server, so run `npm run build` first.

The `panel-*.png` images show the panel from before 0.1.5, when it was a set
of React components wired in by hand.

`social-preview.png` is what a link to the repository shows on social media. GitHub
has no API for it: upload it under **Settings → General → Social preview**.
