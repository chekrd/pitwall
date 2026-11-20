// Documents in the shapes HumanLayer's rpi skill writes, about made-up features of the mock's repositories: CSV
// export of invoices (design discussion, an outline one phase in) and a search page for the docs (PRD then TDD,
// at research).

const repos = (identifier: string, sha: string) => `repos:\n  - identifier: ${identifier}\n    sha: ${sha}\n`;
const BILLING = repos('acme/billing-api', '4f1c2d9');
const DOCS = repos('acme/docs-site', 'a81e07b');

const EXPORT = {
  '01-request-invoice-export.md': `---
type: request
${BILLING}---

# Original Request: Invoice CSV export

Finance wants to download a month of invoices as CSV for their spreadsheet, instead of copying rows from the PDF list.

## Source Pointers

- \`src/invoices/list.ts\`
- \`src/routes/invoices.ts\`
`,
  '02-research-questions-invoice-export.md': `---
type: research-questions
${BILLING}flow: design-discussion
---

# Research Questions: Invoice CSV export

## Key Context Pointers

- \`src/invoices/list.ts\`, \`src/routes/invoices.ts\`

## Questions

1. How does \`GET /invoices\` page through a month of invoices, and what does one row hold?
2. Where are amounts rounded, and in which currency are they stored?
3. Which jobs already stream large responses, and how are they tested?
`,
  '03-research-invoice-export.md': `---
date: 2026-11-18T10:12:00+01:00
${BILLING}topic: "Invoice CSV export"
type: research
tags: [research, invoices, export]
status: complete
---

# Research: Invoice CSV export

## Research Question

The three questions in [the research questions](02-research-questions-invoice-export.md).

## Summary

\`GET /invoices\` reads a month through \`listInvoices\`, 50 rows a page, and the PDF list renders each page as it comes. Amounts are stored in minor units and rounded only when formatted.

## Detailed Findings

### 1. A month is read one page at a time

\`\`\`mermaid
sequenceDiagram
    participant UI as Invoices page
    participant API as GET /invoices
    participant DB as listInvoices
    UI->>API: month=2026-10, page=1
    API->>DB: 50 rows from the cursor
    DB-->>API: rows and next cursor
    API-->>UI: page 1 of 9
\`\`\`

| Field | Source | Note |
| --- | --- | --- |
| \`number\` | \`invoices.number\` | unique per tenant |
| \`total\` | \`invoices.total_minor\` | minor units |
| \`currency\` | \`invoices.currency\` | ISO 4217 |

#### Testing Patterns

\`test/invoices/list.test.ts\` seeds a month with \`seedInvoices(120)\`.

## Open Questions

None.
`,
  '04-design-discussion-invoice-export.md': `---
type: design-discussion
${BILLING}---

# Design Discussion: Invoice CSV export

## Summary of the Request

A month of invoices as one CSV download, built from [the research](03-research-invoice-export.md).

## Current State

Finance copies rows from the PDF list, page by page.

## Desired End State

**Export CSV** on the invoices page downloads the month the page shows. See [the export dialog mockup](mockup-export-dialog.html).

![The export's states](diagram-export-states.svg)

## Design Questions

### Stream or build the file first?

Streaming starts the download at once; building first can report a row count. **Recommendation:** stream.

## Resolved Design Questions

- Amounts are written in major units with two decimals, the currency in its own column.

## Patterns to Follow

- \`src/jobs/statement.ts\` streams a large response with \`pipeline\`.
`,
  '05-structure-outline-invoice-export.md': `---
type: structure-outline
${BILLING}---

# Outline: Invoice CSV export

Stream the month from \`listInvoices\` through a CSV writer, then add the button.

## Desired End State

**Export CSV** downloads the month as one file.

## Implementation Overview

- [x] Phase 1: The CSV writer formats one invoice per row ✅
- [ ] Phase 2: \`GET /invoices/export\` streams a month
- [ ] Phase 3: The invoices page has Export CSV

## Phase 1: The CSV writer formats one invoice per row ✅

### Validation

#### Automated Verification

- [x] \`pnpm test csv\` passes

## Phase 2: \`GET /invoices/export\` streams a month

### Validation

#### Automated Verification

- [ ] \`pnpm test invoices/export\` passes

## Phase 3: The invoices page has Export CSV

### Validation

#### Manual Verification

- [ ] The download opens in a spreadsheet

## Open Questions

None.
`,
  'mockup-export-dialog.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Export invoices</title>
<style>body{font:15px system-ui;margin:24px;color:#222;background:#fafafa}.dialog{max-width:420px;padding:20px;border:1px solid #ccc;border-radius:12px;background:#fff}button{font:inherit;padding:6px 14px}</style>
</head><body><div class="dialog"><h1>Export invoices</h1><p>October 2026 · 412 invoices</p><label><input type="checkbox" checked> Include credit notes</label><p><button>Cancel</button> <button>Export CSV</button></p></div></body></html>
`,
  'diagram-export-states.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="90" viewBox="0 0 420 90"><rect width="420" height="90" fill="#fff"/>
<g font-family="sans-serif" font-size="14" fill="#222"><rect x="10" y="25" width="110" height="40" rx="8" fill="none" stroke="#555"/><text x="65" y="50" text-anchor="middle">Idle</text>
<rect x="155" y="25" width="110" height="40" rx="8" fill="none" stroke="#555"/><text x="210" y="50" text-anchor="middle">Streaming</text>
<rect x="300" y="25" width="110" height="40" rx="8" fill="none" stroke="#555"/><text x="355" y="50" text-anchor="middle">Done</text></g>
<path d="M120 45h35M265 45h35" stroke="#555" stroke-width="2"/></svg>
`,
};

const SEARCH = {
  '01-request-search-page.md': `---
type: request
${DOCS}---

# Original Request: A search page for the docs

Readers cannot find a page unless they know its section. Add a search page.
`,
  '02-research-questions-search-page.md': `---
type: research-questions
${DOCS}flow: prd
---

# Research Questions: Docs search

## Questions

1. How are pages built, and where does their text end up?
2. Does the site load anything at run time today?
`,
  '03-research-search-page.md': `---
date: 2026-11-19T15:40:00+01:00
${DOCS}topic: "Docs search"
type: research
tags: [research, search]
status: complete
---

# Research: Docs search

## Summary

Pages are built to static HTML; nothing is fetched at run time.

## Open Questions

None.
`,
};

// The task folders by the worktree each lies in.
export const rpiDocuments = (home: string): Record<string, Record<string, Record<string, string>>> => ({
  [`${home}/code/worktrees/invoice-export/billing-api`]: { 'invoice-export': EXPORT },
  [`${home}/code/worktrees/search-page/docs-site`]: { 'search-page': SEARCH },
});
