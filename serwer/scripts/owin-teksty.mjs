// Jednorazowe narzędzie: owija polskie teksty interfejsu w t('…') (i18n). Uruchom: node scripts/owin-teksty.mjs <plik.js>
// Bezpieczne konteksty: węzły tekstowe w szablonach HTML, atrybuty placeholder/title/aria-label, argumenty toast(),
// wartości text/title/okLabel/cancelLabel/label/error/info, przypisania .startError/.error/.info, new Error(…).
// Stałe na poziomie modułu są pomijane (t() musi działać w chwili wyświetlania, nie przy wczytaniu).
import fs from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: false });
const edits = []; // [start, end, text]
const LETTER = /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/;
const PROSE = /[a-ząćęłńóśźż]{2,}|[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/;
const isProse = (s) => PROSE.test(s) && !/^[\w.-]+$/.test(s.trim()) && !/^(https?:|\.\/|#)/.test(s.trim()) && !/[{};=]/.test(s);
const isProseWord = (s) => PROSE.test(s) && !/[{};=]/.test(s) && !/^(https?:|\.\/|#)/.test(s.trim()) && (/\s/.test(s.trim()) || /[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(s) || /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(s.trim()) || /[.!?…:]$/.test(s.trim()));
const q = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
const UI_KEYS = new Set(['text', 'title', 'okLabel', 'cancelLabel', 'label', 'error', 'info']);
const UI_PROPS = new Set(['startError', 'error', 'info', 'scanError']);

// nazwa zmiennej dla ${…} w szablonie bez HTML
function paramName(node, used) {
  let n = node;
  if (n.type === 'CallExpression' && n.arguments.length === 1 && n.callee.type === 'Identifier' && ['esc', 'String', 'fmtSan'].includes(n.callee.name)) n = n.arguments[0];
  let name = n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' && !n.computed ? n.property.name : 'v';
  if (name === 'length') name = 'n';
  let base = name, i = 2;
  while (used.has(name)) name = base + i++;
  used.add(name);
  return name;
}
const hasHtml = (tpl) => tpl.quasis.some((qq) => /<[a-zA-Z/]/.test(qq.value.raw));

// szablon bez HTML w kontekście UI → t('… {x} …', { x: expr })
function convertPlainTemplate(tpl) {
  const used = new Set();
  let text = '';
  const params = [];
  tpl.quasis.forEach((qq, i) => {
    text += qq.value.cooked;
    if (i < tpl.expressions.length) {
      const e = tpl.expressions[i];
      const name = paramName(e, used);
      text += `{${name}}`;
      params.push(`${name}: ${src.slice(e.start, e.end)}`);
    }
  });
  if (!isProse(text.replace(/\{\w+\}/g, ''))) return false;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
  const core = text.trim();
  const call = `t(${q(core)}${params.length ? `, { ${params.join(', ')} }` : ''})`;
  edits.push([tpl.start, tpl.end, lead || trail ? `\`${lead}\${${call}}${trail}\`` : call]);
  return true;
}
function wrapLiteral(lit) {
  if (typeof lit.value !== 'string' || !isProseWord(lit.value)) return;
  const v = lit.value;
  const lead = v.match(/^\s*/)[0], trail = v.match(/\s*$/)[0];
  const core = v.trim();
  if (!lead && !trail) edits.push([lit.start, lit.end, `t(${q(core)})`]);
  else edits.push([lit.start, lit.end, `${q(lead)} + t(${q(core)}) + ${q(trail)}`]);
}
// wartość w kontekście UI (literał, szablon, warunek, konkatenacja)
function uiValue(node) {
  if (!node) return;
  if (node.type === 'Literal') wrapLiteral(node);
  else if (node.type === 'TemplateLiteral') { if (hasHtml(node)) htmlTemplate(node); else if (!convertPlainTemplate(node)) visitExprs(node); }
  else if (node.type === 'ConditionalExpression') { uiValue(node.consequent); uiValue(node.alternate); }
  else if (node.type === 'LogicalExpression') { uiValue(node.left); uiValue(node.right); }
  else if (node.type === 'BinaryExpression' && node.operator === '+') { uiValue(node.left); uiValue(node.right); }
  else visitGeneric(node);
}
// szablon HTML: węzły tekstowe i wybrane atrybuty; wyrażenia w tekście = UI, w znacznikach = kod
const TEXT_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
function wrapTextRun(raw, base, start, end) {
  const seg = raw.slice(start, end);
  if (!LETTER.test(seg)) return;
  const core = seg.trim();
  if (!PROSE.test(core) || core.length < 2) return;
  if (/^[\w-]+$/.test(core) && !/[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(core) && !/^[A-ZĄĆĘŁŃÓŚŹŻ][a-z]/.test(core)) return; // np. klasa, identyfikator
  if (/[{};=]/.test(core)) return;
  const off = seg.indexOf(core);
  const cooked = core.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\s+/g, ' '); // HTML i tak zwija odstępy
  edits.push([base + start + off, base + start + off + core.length, `\${t(${q(cooked)})}`]);
}
function htmlTemplate(tpl) {
  let inTag = false, attr = null, inQuote = null, attrValStart = null;
  tpl.quasis.forEach((qq, qi) => {
    const raw = src.slice(qq.start, qq.end); // z pliku (CRLF!), nie value.raw
    const base = qq.start;
    let runStart = inTag ? null : 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (!inTag) {
        if (ch === '<' && /[a-zA-Z/!]/.test(raw[i + 1] || '')) { if (runStart !== null) wrapTextRun(raw, base, runStart, i); runStart = null; inTag = true; attr = null; }
        else if (runStart === null) runStart = i;
      } else if (inQuote) {
        if (ch === inQuote) {
          if (attrValStart !== null && TEXT_ATTRS.includes(attr)) {
            const val = raw.slice(attrValStart, i);
            if (isProseWord(val) && !val.includes('$')) edits.push([base + attrValStart, base + i, `\${t(${q(val)})}`]);
          }
          inQuote = null; attrValStart = null;
        }
      } else if (ch === '"' || ch === "'") { inQuote = ch; attrValStart = i + 1; }
      else if (ch === '>') { inTag = false; runStart = i + 1; }
      else if (/[\w-]/.test(ch)) { let j = i; while (j < raw.length && /[\w-]/.test(raw[j])) j++; attr = raw.slice(i, j).toLowerCase(); i = j - 1; }
    }
    if (!inTag && runStart !== null) wrapTextRun(raw, base, runStart, raw.length);
    if (qi < tpl.expressions.length) {
      const e = tpl.expressions[qi];
      if (inTag) {
        if (inQuote && TEXT_ATTRS.includes(attr)) uiValue(e); else visitGeneric(e);
        if (inQuote) attrValStart = null; // wartość atrybutu z ${…} — reszty nie owijamy
      } else uiValue(e);
    }
  });
}
function visitExprs(tpl) { for (const e of tpl.expressions) visitGeneric(e); }

// przejście po całym kodzie z kontekstami UI
let topLevelDecl = new Set();
for (const n of ast.body) if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.init) topLevelDecl.add(d.init);
const done = new WeakSet();
function visitGeneric(node) {
  if (!node || done.has(node)) return;
  walk.recursive(node, null, {
    VariableDeclarator(n, st, c) { if (topLevelDecl.has(n.init)) return; if (n.init) c(n.init, st); },
    TemplateLiteral(n, st, c) { if (done.has(n)) return; done.add(n); if (hasHtml(n)) htmlTemplate(n); else for (const e of n.expressions) c(e, st); },
    CallExpression(n, st, c) {
      const name = n.callee.type === 'Identifier' ? n.callee.name : n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property.name : '';
      if (name === 't' || name === 'tn') return;
      c(n.callee, st);
      n.arguments.forEach((a, i) => { if (name === 'toast' && i === 0) uiValue(a); else c(a, st); });
    },
    NewExpression(n, st, c) { if (n.callee.name === 'Error' && n.arguments[0]) uiValue(n.arguments[0]); else n.arguments.forEach((a) => c(a, st)); },
    Property(n, st, c) {
      const key = n.key.type === 'Identifier' ? n.key.name : n.key.value;
      if (!n.computed && UI_KEYS.has(key) && !n.shorthand) uiValue(n.value); else c(n.value, st);
    },
    AssignmentExpression(n, st, c) {
      const p = n.left.type === 'MemberExpression' && !n.left.computed ? n.left.property.name : '';
      c(n.left, st);
      if (UI_PROPS.has(p)) uiValue(n.right); else c(n.right, st);
    },
  });
}
for (const n of ast.body) {
  if (n.type === 'VariableDeclaration' && n.declarations.every((d) => !d.init || d.init.type !== 'ArrowFunctionExpression' && d.init.type !== 'FunctionExpression')) continue; // stałe modułu
  visitGeneric(n);
}

// zastosowanie (od końca; nakładające się pomijamy)
edits.sort((a, b) => b[0] - a[0]);
let out = src, lastStart = Infinity, applied = 0;
for (const [s, e, txt] of edits) {
  if (e > lastStart) continue;
  out = out.slice(0, s) + txt + out.slice(e);
  lastStart = s; applied++;
}
fs.writeFileSync(file, out);
console.log(`${file}: ${applied} zmian`);
