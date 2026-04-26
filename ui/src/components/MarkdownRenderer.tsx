// Lightweight markdown renderer

/** Lightweight markdown-to-HTML renderer — no external deps. */
export default function MarkdownRenderer({ content }: { content: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}

function renderMarkdown(src: string): string {
  let html = escapeHtml(src);

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Tables
  html = html.replace(/((?:\|.+\|\n)+)/g, (_match, block: string) => {
    const rows = block.trim().split('\n');
    if (rows.length < 2) return block;
    const hCells = rows[0].split('|').filter(c => c.trim());
    const isSep = rows[1] && /^[\s|:-]+$/.test(rows[1]);
    const bodyStart = isSep ? 2 : 1;
    let t = '<table><thead><tr>';
    for (const c of hCells) t += `<th>${c.trim()}</th>`;
    t += '</tr></thead><tbody>';
    for (let i = bodyStart; i < rows.length; i++) {
      const cells = rows[i].split('|').filter(c => c.trim());
      t += '<tr>';
      for (const c of cells) t += `<td>${c.trim()}</td>`;
      t += '</tr>';
    }
    t += '</tbody></table>';
    return t;
  });

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr/>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.+<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Paragraphs (lines that don't start with a tag)
  html = html.replace(/^(?!<[a-z/])(.+)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
