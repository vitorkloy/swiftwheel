const KEYWORDS: Record<string, string[]> = {
  javascript: ['break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','finally','for','function','if','import','in','instanceof','let','new','return','static','super','switch','this','throw','try','typeof','var','void','while','with','yield','async','await','of'],
  typescript: ['break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','finally','for','function','if','import','in','instanceof','let','new','return','static','super','switch','this','throw','try','typeof','var','void','while','with','yield','async','await','of','type','interface','enum','implements','private','public','protected','readonly','as','satisfies'],
  python: ['and','as','assert','async','await','break','class','continue','def','del','elif','else','except','False','finally','for','from','global','if','import','in','is','lambda','None','nonlocal','not','or','pass','raise','return','True','try','while','with','yield'],
  rust: ['as','async','await','break','const','continue','crate','dyn','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','Self','static','struct','super','trait','true','type','unsafe','use','where','while'],
  go: ['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var'],
  c: ['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','inline','int','long','register','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while'],
  csharp: ['abstract','as','base','bool','break','byte','case','catch','char','checked','class','const','continue','decimal','default','delegate','do','double','else','enum','event','explicit','extern','false','finally','fixed','float','for','foreach','goto','if','implicit','in','int','interface','internal','is','lock','long','namespace','new','null','object','operator','out','override','params','private','protected','public','readonly','ref','return','sbyte','sealed','short','sizeof','stackalloc','static','string','struct','switch','this','throw','true','try','typeof','uint','ulong','unchecked','unsafe','ushort','using','virtual','void','volatile','while','var','async','await'],
  java: ['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while'],
  ruby: ['alias','and','begin','break','case','class','def','defined','do','else','elsif','end','ensure','false','for','if','in','module','next','nil','not','or','redo','rescue','retry','return','self','super','then','true','undef','unless','until','when','while','yield'],
  php: ['abstract','and','array','as','break','callable','case','catch','class','clone','const','continue','declare','default','die','do','echo','else','elseif','empty','enddeclare','endfor','endforeach','endif','endswitch','endwhile','eval','exit','extends','final','finally','fn','for','foreach','function','global','goto','if','implements','include','include_once','instanceof','insteadof','interface','isset','list','match','namespace','new','or','print','private','protected','public','require','require_once','return','static','switch','throw','trait','try','unset','use','var','while','xor','yield'],
  kotlin: ['as','break','class','continue','do','else','false','for','fun','if','in','interface','is','null','object','package','return','super','this','throw','true','try','typealias','typeof','val','var','when','while'],
  swift: ['as','associatedtype','break','case','catch','class','continue','default','defer','deinit','do','else','enum','extension','fallthrough','false','fileprivate','for','func','guard','if','import','in','init','inout','internal','is','let','nil','open','operator','private','protocol','public','repeat','rethrows','return','self','static','struct','subscript','super','switch','throw','throws','true','try','typealias','var','where','while'],
  bash: ['if','then','else','elif','fi','for','while','until','do','done','case','esac','in','function','select','time','[[',']]'],
  powershell: ['begin','break','catch','class','continue','data','define','do','dynamicparam','else','elseif','end','exit','filter','finally','for','foreach','from','function','if','in','param','process','return','switch','throw','trap','try','until','using','var','while'],
  sql: ['select','from','where','and','or','insert','into','update','set','delete','create','table','alter','drop','join','left','right','inner','outer','group','by','order','limit','values','as','on','not','null','is','in','like','between','distinct','having','union','all'],
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(kind: string, text: string) {
  return `<span class="tok-${kind}">${text}</span>`;
}

/** Destaque simples depois de escapar — não corre markup do ficheiro. */
export function highlightCode(source: string, lang: string): string {
  const escaped = escapeHtml(source);
  const key = lang === 'javascript' || lang === 'typescript' ? lang : (KEYWORDS[lang] ? lang : '');
  if (lang === 'json') {
    return escaped.replace(
      /(&quot;[^&]*&quot;)(\s*:\s*)|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (all, keyStr, colon, boolish, num) => {
        if (keyStr) return `${wrap('key', keyStr)}${colon}`;
        if (boolish) return wrap('kw', boolish);
        if (num) return wrap('num', num);
        return all;
      },
    );
  }
  const keywords = key ? KEYWORDS[key] : [];
  const kwRe = keywords.length
    ? new RegExp(`\\b(?:${keywords.map((k) => k.replace(/[[\]]/g, '\\$&')).join('|')})\\b`, 'g')
    : null;
  const parts: string[] = [];
  const tokenRe = /(&quot;(?:\\.|[^&])*?&quot;|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(escaped))) {
    const chunk = escaped.slice(last, match.index);
    parts.push(kwRe ? chunk.replace(kwRe, (m) => wrap('kw', m)) : chunk);
    const tok = match[0];
    if (tok.startsWith('//') || tok.startsWith('#') || tok.startsWith('/*')) parts.push(wrap('cm', tok));
    else if (tok.startsWith('&quot;') || tok.startsWith("'") || tok.startsWith('`')) parts.push(wrap('str', tok));
    else parts.push(wrap('num', tok));
    last = match.index + tok.length;
  }
  const tail = escaped.slice(last);
  parts.push(kwRe ? tail.replace(kwRe, (m) => wrap('kw', m)) : tail);
  return parts.join('');
}
