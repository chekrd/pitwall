import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlText } from './htmlText.ts';

test("an artifact's visible text reads one line a block, without its scripts, styles or comments, entities decoded", () => {
  const html = `<!doctype html><html><head><title>Export &amp; stream</title><style>h1 { color: red }</style>
    <script>document.title = '<p>not text</p>';</script></head>
    <body><!-- a note --><h1>How the export streams</h1><ol><li>The page asks</li><li>The server reads &lt;500&gt; rows</li></ol>
    <p>Streaming <em>starts</em>&nbsp;at once &#8212; or &#x2192; not.</p><svg><text x="1">Idle</text><text>Done</text></svg>
    <script type="module">alert(1)</script><template><p>hidden</p></template></body></html>`;
  assert.equal(htmlText(html), ['Export & stream', 'How the export streams', '• The page asks', '• The server reads <500> rows', 'Streaming starts at once — or → not.', 'Idle', 'Done'].join('\n'));
  assert.equal(htmlText('&amp;lt;b&amp;gt;'), '&lt;b&gt;', 'decoded once');
  assert.equal(htmlText(''), '');
});
