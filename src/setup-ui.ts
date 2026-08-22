/**
 * The setup page, as one self-contained string.
 *
 * No build step, no bundler, no CDN — a single inlined document, because this
 * is served by a container someone started with one command and the page must
 * work with no network beyond the gateway itself.
 *
 * The privacy claim on the page is a claim about the architecture, so it has to
 * stay true: the key goes from this form to the local gateway, the gateway
 * sends it only to that provider, and it is written to a file inside the user's
 * own volume. There is no hosted component, nothing phones home, and the API
 * never returns a stored key. If any of that changes, change the page text in
 * the same commit.
 *
 * ## The pictures
 *
 * Each step of a provider's guide gets a diagram of the screen it describes,
 * drawn here as SVG from the step's own text: the label inside 「」 becomes the
 * highlighted control. Nothing is invented — the words were already in the
 * registry, this only draws them — and every diagram is captioned as a diagram,
 * because a drawing presented as a screenshot is a lie about how current it is.
 *
 * A real screenshot wins where one exists. Drop `groq-1.png` into the shots
 * directory and the first Groq step shows that instead. The images are fetched
 * with the token and shown as blob URLs rather than linked directly, since they
 * are pictures of somebody's own console and are behind the same auth as the
 * rest of the API.
 */

export const SETUP_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InferenceMesh — セットアップ</title>
<style>
:root{
  --bg:#f7f7f8; --panel:#fff; --fg:#16171a; --mut:#5f636b; --faint:#8b8f98;
  --line:#e3e4e8; --line2:#eceef1;
  --ok:#0a7a3f; --okbg:#e9f6ee; --bad:#b3261e; --badbg:#fdecea;
  --acc:#1a56db; --accbg:#eaf0fd; --shadow:0 1px 2px rgba(16,17,20,.06),0 4px 16px rgba(16,17,20,.05);
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0e0f11; --panel:#17181c; --fg:#e9eaee; --mut:#a1a5ad; --faint:#7b8089;
  --line:#282a30; --line2:#212328;
  --ok:#4ade80; --okbg:#12261a; --bad:#f87171; --badbg:#2a1516;
  --acc:#7aa2f7; --accbg:#151d2e; --shadow:none;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:2.5rem 1.1rem 6rem}
h1{font-size:1.6rem;letter-spacing:-.01em;margin:0 0 .35rem}
.sub{color:var(--mut);margin:0 0 1.6rem}

/* progress */
.bar{height:6px;border-radius:99px;background:var(--line2);overflow:hidden;margin:.6rem 0 .4rem}
.bar>i{display:block;height:100%;background:var(--ok);width:0;transition:width .35s ease}
.count{font-size:.85rem;color:var(--mut);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}

/* the promise box */
.note{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:1rem 1.15rem;margin:1.5rem 0;font-size:.9rem;box-shadow:var(--shadow)}
.note b{display:block;margin-bottom:.35rem}
.note ul{margin:.4rem 0 0;padding-left:1.15rem;color:var(--mut)}
.note li{margin:.2rem 0}

/* provider card */
.p{border:1px solid var(--line);border-radius:14px;background:var(--panel);
  padding:1.1rem 1.2rem;margin-bottom:1rem;box-shadow:var(--shadow)}
.p.done{background:transparent;box-shadow:none;padding:.85rem 1.2rem}
.head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.name{font-size:1.08rem;font-weight:650;margin:0}
.tag{font-size:.72rem;padding:.18rem .55rem;border-radius:99px;border:1px solid var(--line);
  color:var(--mut);font-weight:500;white-space:nowrap}
.tag.ok{color:var(--ok);background:var(--okbg);border-color:transparent}
.tag.todo{color:var(--acc);background:var(--accbg);border-color:transparent}
.desc{color:var(--mut);font-size:.9rem;margin:.45rem 0 0}
.p.done .desc{display:none}

/* steps */
.steps{list-style:none;margin:1.1rem 0 .2rem;padding:0;display:grid;gap:1rem}
.step{display:grid;grid-template-columns:1.7rem 1fr;gap:.7rem;align-items:start}
.n{width:1.7rem;height:1.7rem;border-radius:99px;background:var(--accbg);color:var(--acc);
  font-size:.8rem;font-weight:700;display:grid;place-items:center;margin-top:.15rem}
.stxt{margin:0 0 .5rem;font-size:.92rem}
figure{margin:0}
figure img,figure svg{display:block;width:100%;max-width:26rem;height:auto;
  border:1px solid var(--line);border-radius:10px;background:var(--panel)}
figcaption{color:var(--faint);font-size:.72rem;margin-top:.3rem}
.open{display:inline-block;margin:.2rem 0 1rem;font-size:.9rem}
a{color:var(--acc)}

/* form */
.row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem}
input{flex:1 1 15rem;min-width:0;padding:.65rem .8rem;border:1px solid var(--line);border-radius:10px;
  background:var(--bg);color:var(--fg);font:inherit;font-size:.92rem}
input:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button{padding:.65rem 1.15rem;border:0;border-radius:10px;background:var(--acc);color:#fff;
  font:inherit;font-size:.92rem;font-weight:600;cursor:pointer;white-space:nowrap}
button.ghost{background:transparent;color:var(--mut);border:1px solid var(--line);font-weight:500}
button:disabled{opacity:.55;cursor:default}
.msg{font-size:.86rem;margin-top:.55rem;min-height:1.3em}
.msg.ok{color:var(--ok)}
.msg.bad{color:var(--bad)}
.hint{color:var(--faint);font-size:.8rem;margin-top:.4rem}

details{margin-top:.9rem}
summary{cursor:pointer;font-size:.9rem;color:var(--acc);font-weight:500}
summary::marker{color:var(--faint)}

#gate{background:var(--panel);border:1px solid var(--bad);border-radius:14px;padding:1.1rem 1.2rem;margin-bottom:1.5rem}
.foot{color:var(--mut);font-size:.85rem;margin-top:2.5rem;border-top:1px solid var(--line);padding-top:1.1rem}
code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:.08rem .35rem;font-size:.85em}
@media(max-width:520px){
  .wrap{padding-top:1.6rem}
  .step{grid-template-columns:1.4rem 1fr;gap:.55rem}
  button{flex:1 1 100%}
}
</style>
</head>
<body><div class="wrap">

<h1>InferenceMesh — セットアップ</h1>
<p class="sub">無料のAIモデルを使えるようにします。クレジットカードは要りません。</p>

<div id="prog" hidden>
  <div class="bar"><i id="bari"></i></div>
  <div class="count"><span id="cnt"></span><span id="usable"></span></div>
</div>

<div class="note">
  <b>あなたの鍵は、このパソコンから出ません。</b>
  <ul>
    <li>貼った鍵は、この画面からあなた自身のサーバー（いま開いているこのアドレス）にだけ送られます</li>
    <li>そこから先は、その鍵の発行元（Groq や NVIDIA など）以外には送られません</li>
    <li>保存後は画面に表示されません。「設定済み」とだけ出ます</li>
    <li>このソフトは全部オープンソースで、外部に送信する仕組みは入っていません</li>
  </ul>
</div>

<div id="gate" hidden>
  <b>アクセストークンが必要です。</b>
  <p class="hint">サーバーを起動したときに表示された <code>INFERENCEMESH_TOKENS</code> の値を貼ってください。</p>
  <div class="row"><input id="tok" type="password" placeholder="アクセストークン" autocomplete="off"><button id="tokgo">続ける</button></div>
  <div class="msg" id="tokmsg"></div>
</div>

<div id="list"></div>

<div class="foot" id="foot"></div>
</div>
<script>
// The token arrives in the URL fragment. Fragments are never sent to a server
// and never land in an access log, which a query string would.
let TOKEN = location.hash.slice(1);
let SHOTS = {};
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; };
// textContent/innerHTML does not touch quotes, which is fine inside an element
// and not fine inside an attribute — one quote in a label would end the
// attribute early. Everything that lands in an attribute goes through this.
const escA = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function api(path, opts) {
  const r = await fetch(path, Object.assign({headers:{'authorization':'Bearer '+TOKEN,'content-type':'application/json'}}, opts||{}));
  if (r.status === 401) throw new Error('unauthorized');
  return r.json();
}

/* ---------------------------------------------------------------------- *
 * Diagrams
 *
 * Drawn from what each step already says, never from anything invented about
 * a console nobody here has seen. A step falls into one of five shapes — open
 * an address, sign in, walk a menu, press a named control, copy the string
 * that appears — and each is drawn as that action and nothing more specific.
 *
 * A step that fits none of them gets no picture. A decorative box that means
 * nothing is worse than a paragraph on its own.
 * ---------------------------------------------------------------------- */
const CH = {                                  // shared chrome geometry
  w: 420, h: 190,
  frame: (host, body) =>
    '<rect x=".5" y=".5" width="419" height="189" rx="9" fill="var(--panel)" stroke="var(--line)"/>' +
    '<rect x=".5" y=".5" width="419" height="30" rx="9" fill="var(--bg)" stroke="var(--line)"/>' +
    '<circle cx="18" cy="16" r="4" fill="var(--line)"/><circle cx="32" cy="16" r="4" fill="var(--line)"/><circle cx="46" cy="16" r="4" fill="var(--line)"/>' +
    (host ? '<text x="66" y="20" font-size="11" fill="var(--faint)">' + esc(host) + '</text>' : '') +
    body,
};
const svg = (label, inner) =>
  '<svg viewBox="0 0 420 190" role="img" aria-label="' + escA(label) + '">' + inner + '</svg>';
const arrow = (x, y, text) =>
  '<path d="M' + (x + 16) + ' ' + y + ' h30" stroke="var(--acc)" stroke-width="2" fill="none"/>' +
  '<path d="M' + (x + 14) + ' ' + (y - 6) + ' l-8 6 8 6z" fill="var(--acc)"/>' +
  '<text x="' + (x + 54) + '" y="' + (y + 5) + '" font-size="12" fill="var(--acc)">' + esc(text) + '</text>';

function controlOf(text) {
  const m = String(text).match(/[「『"']([^」』"']{2,40})[」』"']/);
  return m ? m[1] : null;
}
function hostIn(text) {
  const m = String(text).match(/([a-z0-9-]+\\.)+(com|net|org|ai|cn|io|jp|dev|app)(\\/[A-Za-z0-9\\/_-]*)?/);
  return m ? m[0] : null;
}
function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}
function prefixIn(text, fallback) {
  const m = String(text).match(/([A-Za-z][A-Za-z0-9]*[-_](?:v\\d+-)?)\\s*で始まる/);
  return (m ? m[1] : null) || fallback || null;
}

/** Open an address. */
const dOpen = (host) => svg(host + ' を開く', CH.frame('', 
  '<rect x="66" y="8" width="290" height="16" rx="8" fill="var(--panel)" stroke="var(--line)"/>' +
  '<text x="76" y="20" font-size="11" fill="var(--fg)">' + esc(host) + '</text>' +
  '<rect x="24" y="58" width="180" height="10" rx="5" fill="var(--line)"/>' +
  '<rect x="24" y="80" width="330" height="7" rx="3" fill="var(--line2)"/>' +
  '<rect x="24" y="96" width="270" height="7" rx="3" fill="var(--line2)"/>' +
  arrow(356, 16, '')));

/** Sign in. */
const dSignin = (host) => svg('ログイン', CH.frame(host,
  '<rect x="120" y="52" width="180" height="110" rx="10" fill="var(--bg)" stroke="var(--line)"/>' +
  '<text x="210" y="76" text-anchor="middle" font-size="12" fill="var(--mut)">ログイン</text>' +
  '<rect x="138" y="88" width="144" height="18" rx="6" fill="var(--panel)" stroke="var(--line)"/>' +
  '<rect x="138" y="112" width="144" height="18" rx="6" fill="var(--panel)" stroke="var(--line)"/>' +
  '<rect x="138" y="138" width="144" height="16" rx="8" fill="var(--acc)"/>'));

/** Walk a menu: chips, last one highlighted. */
function dMenu(parts, host) {
  let x = 24, out = '';
  parts.slice(0, 4).forEach((label, i, all) => {
    const w = Math.min(130, 18 + label.length * 9);
    const last = i === all.length - 1;
    out += '<rect x="' + x + '" y="70" width="' + w + '" height="26" rx="7" fill="' +
      (last ? 'var(--acc)' : 'var(--bg)') + '" stroke="' + (last ? 'var(--acc)' : 'var(--line)') + '"/>' +
      '<text x="' + (x + w / 2) + '" y="' + 87 + '" text-anchor="middle" font-size="11" fill="' +
      (last ? '#fff' : 'var(--fg)') + '">' + esc(label) + '</text>';
    x += w;
    if (!last) {
      out += '<text x="' + (x + 9) + '" y="87" font-size="12" fill="var(--faint)">›</text>';
      x += 22;
    }
  });
  return svg(parts.join(' → '), CH.frame(host, out));
}

/** Press a named control. */
function dPress(label, host) {
  const w = Math.min(300, 22 + label.length * 9.5), x = 40, y = 104;
  return svg(label + ' を押す', CH.frame(host,
    '<rect x="24" y="52" width="150" height="9" rx="4" fill="var(--line)"/>' +
    '<rect x="24" y="72" width="240" height="7" rx="3" fill="var(--line2)"/>' +
    '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="38" rx="9" fill="var(--acc)"/>' +
    '<text x="' + (x + w / 2) + '" y="' + (y + 24) + '" text-anchor="middle" font-size="13" font-weight="600" fill="#fff">' +
      esc(label) + '</text>' +
    arrow(x + w, y + 19, 'ここ')));
}

/** Copy the string that appears. */
function dCopy(prefix) {
  const shown = (prefix || 'sk-') + '••••••••••••••••';
  return svg('表示された鍵をコピーする', CH.frame('',
    '<rect x="24" y="58" width="372" height="52" rx="9" fill="var(--bg)" stroke="var(--line)"/>' +
    '<text x="40" y="90" font-size="13" font-family="ui-monospace,monospace" fill="var(--fg)">' + esc(shown) + '</text>' +
    '<rect x="288" y="122" width="108" height="30" rx="8" fill="var(--acc)"/>' +
    '<text x="342" y="142" text-anchor="middle" font-size="12" font-weight="600" fill="#fff">コピー</text>' +
    '<text x="24" y="142" font-size="11" fill="var(--bad)">一度しか表示されません</text>'));
}


/** Where on the screen a thing is, when the step says where. */
function dFind(term, side) {
  const right = side !== 'left';
  const px = right ? 268 : 24;
  return svg(term + ' の場所', CH.frame('',
    '<rect x="' + (right ? 24 : 152) + '" y="44" width="244" height="128" rx="8" fill="var(--bg)" stroke="var(--line2)"/>' +
    '<rect x="' + px + '" y="44" width="128" height="128" rx="8" fill="var(--panel)" stroke="var(--acc)"/>' +
    '<text x="' + (px + 64) + '" y="100" text-anchor="middle" font-size="12" font-weight="600" fill="var(--acc)">' +
      esc(term) + '</text>' +
    '<text x="' + (px + 64) + '" y="120" text-anchor="middle" font-size="10" fill="var(--faint)">' +
      (right ? 'この辺り' : 'この辺り') + '</text>'));
}

/**
 * Pick the shape that matches this step. Order matters: a step that names a
 * control is about pressing it, even when it also mentions a menu path.
 */
function diagramFor(step, ctx) {
  const text = String(step);
  const label = controlOf(text);
  const host = hostIn(text) || ctx.host;
  if (label) return dPress(label, hostIn(text) ? '' : ctx.host);
  if (text.includes('→')) {
    const parts = text.split('→').map(t => t.replace(/^[^A-Za-z0-9ぁ-んァ-ヶ一-龠]+/, '').trim()).filter(Boolean);
    if (parts.length > 1) return dMenu(parts, ctx.host);
  }
  if (/コピー|一度だけ|一度しか/.test(text)) return dCopy(prefixIn(text, ctx.keyPrefix));
  if (/ログイン|サインイン|アカウントを作|Login|Sign ?in/i.test(text)) return dSignin(host);
  if (hostIn(text)) return dOpen(hostIn(text));
  // "右上のメニューから API Keys を開く" — the thing being opened is a place in
  // the interface, not an address, so it is drawn as one.
  const opens = text.match(/([A-Za-z][A-Za-z0-9 ]{1,20}|[ぁ-んァ-ヶ一-龠]{2,10})\\s*を開く/);
  if (opens) return dMenu([opens[1].trim()], ctx.host);
  // "Account ID（ダッシュボード右側に表示）も必要です" — the step says where.
  const where = text.match(/([A-Za-z][A-Za-z0-9 ]{1,20}|[ぁ-んァ-ヶ一-龠]{2,10})\\s*[（(][^）)]*(右|左)[^）)]*[）)]/);
  if (where) return dFind(where[1].trim(), where[2] === '左' ? 'left' : 'right');
  if (/表示され/.test(text)) return dCopy(prefixIn(text, ctx.keyPrefix));
  return null;
}

function stepList(p, steps) {
  const host = hostOf(p.signupUrl || '');
  const ol = document.createElement('ol');
  ol.className = 'steps';
  steps.forEach((s, i) => {
    const pic = diagramFor(s, { host: host, keyPrefix: p.keyPrefix });
    const li = document.createElement('li');
    li.className = 'step';
    li.innerHTML = '<div class="n">' + (i + 1) + '</div><div>' +
      '<p class="stxt">' + esc(s) + '</p>' +
      (pic ? '<figure data-i="' + i + '">' + pic +
        '<figcaption>イメージ図です。実際の画面とは異なる場合があります。</figcaption></figure>' : '') +
      '</div>';
    ol.appendChild(li);
  });
  // Swap in real screenshots where they exist. Done after the list is on the
  // page so a slow image never delays the form the person came here to use.
  steps.forEach(async (_s, i) => {
    const url = await shotFor(p.id, i);
    if (!url) return;
    const fig = ol.querySelector('figure[data-i="' + i + '"]') || (() => {
      const f = document.createElement('figure');
      f.dataset.i = String(i);
      ol.children[i].lastElementChild.appendChild(f);
      return f;
    })();
    fig.innerHTML = '<img alt="手順 ' + (i + 1) + ' の画面" src="' + url + '">' +
      '<figcaption>実際の画面（この端末に置かれたもの）</figcaption>';
  });
  return ol;
}

function providerCard(p) {
  const el = document.createElement('div');
  const settled = p.configured || p.keyless;
  el.className = 'p' + (settled ? ' done' : '');
  const steps = (p.signupSteps && (p.signupSteps.ja || p.signupSteps.en)) || [];
  const tag = p.keyless ? '<span class="tag ok">鍵なしで使えます</span>'
            : p.configured ? '<span class="tag ok">設定済み</span>'
            : '<span class="tag todo">未設定</span>';

  const head = '<div class="head"><h2 class="name">' + esc(p.id) + '</h2>' + tag +
    '<span class="tag">モデル ' + p.models + '</span></div>' +
    (p.summary ? '<p class="desc">' + esc(p.summary) + '</p>' : '') +
    (p.freeTierNote ? '<p class="desc">' + esc(p.freeTierNote) + '</p>' : '');

  if (settled) { el.innerHTML = head; return el; }

  el.innerHTML = head +
    (p.signupUrl ? '<p class="open"><a href="' + escA(p.signupUrl) + '" target="_blank" rel="noopener noreferrer">' +
      esc(hostOf(p.signupUrl)) + ' を開く →</a></p>' : '') +
    '<div class="row">' +
      (p.accountIdEnv ? '<input class="acct" placeholder="Account ID" autocomplete="off">' : '') +
      '<input class="key" type="password" autocomplete="off" placeholder="ここに鍵を貼る' +
        (p.keyPrefix ? '（' + escA(p.keyPrefix) + '… で始まります）' : '') + '">' +
      '<button class="go">確認して保存</button>' +
      '<button class="ghost peek" type="button" title="入力した鍵を表示">表示</button>' +
    '</div>' +
    '<div class="msg"></div>';

  if (steps.length) {
    const d = document.createElement('details');
    d.open = true;
    d.innerHTML = '<summary>鍵の取り方（' + steps.length + ' ステップ）</summary>';
    d.appendChild(stepList(p, steps));
    el.appendChild(d);
  }

  const btn = $('.go', el), key = $('.key', el), acct = $('.acct', el), msg = $('.msg', el), peek = $('.peek', el);
  peek.onclick = () => {
    key.type = key.type === 'password' ? 'text' : 'password';
    peek.textContent = key.type === 'password' ? '表示' : '隠す';
  };
  btn.onclick = async () => {
    const value = key.value.trim();
    if (!value) { msg.className = 'msg bad'; msg.textContent = '鍵を貼ってください。'; key.focus(); return; }
    // Shape check before spending a network round trip: catches "copied the
    // wrong string off the page", which is the common mistake.
    if (p.keyPrefix && !value.startsWith(p.keyPrefix)) {
      msg.className = 'msg bad';
      msg.textContent = 'この鍵は ' + p.keyPrefix + ' で始まるはずです。別の文字列をコピーしていませんか？';
      return;
    }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '確認しています… 実際に1回だけ質問を送っています。';
    try {
      const body = {providerId: p.id, key: value};
      if (acct && acct.value.trim()) body.accountId = acct.value.trim();
      const r = await api('/v1/keys', {method:'POST', body: JSON.stringify(body)});
      if (r.ok) {
        msg.className = 'msg ok';
        msg.textContent = '使えました（' + r.ms + 'ms）。保存しました。';
        setTimeout(load, 700);
      } else {
        msg.className = 'msg bad';
        msg.textContent = 'この鍵では動きませんでした: ' + (r.why || '理由不明');
        btn.disabled = false;
      }
    } catch (e) {
      msg.className = 'msg bad'; msg.textContent = String(e.message || e); btn.disabled = false;
    }
  };
  key.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
  return el;
}

async function load() {
  try {
    const d = await api('/v1/providers');
    try { SHOTS = await api('/setup/shots.json'); } catch { SHOTS = {}; }
    const list = $('#list'); list.innerHTML = '';
    // Unfinished ones first: this page exists to be finished, not admired.
    const order = d.providers.slice().sort((a, b) =>
      Number(a.configured || a.keyless) - Number(b.configured || b.keyless));
    for (const p of order) list.appendChild(providerCard(p));

    const settled = d.providers.filter(p => p.configured || p.keyless).length;
    $('#prog').hidden = false;
    $('#bari').style.width = Math.round((settled / Math.max(1, d.providers.length)) * 100) + '%';
    $('#cnt').textContent = settled + ' / ' + d.providers.length + ' 使える状態';
    $('#usable').textContent = 'いま選べるモデル ' + d.candidates + ' 件';
    $('#foot').textContent = d.usable.length
      ? '有効: ' + d.usable.join(', ')
      : 'まだ1つも有効になっていません。上のどれか1つで十分です。';
    $('#gate').hidden = true;
  } catch (e) {
    if (String(e.message) === 'unauthorized') {
      $('#gate').hidden = false; $('#list').innerHTML = ''; $('#prog').hidden = true;
    } else $('#foot').textContent = String(e.message || e);
  }
}

$('#tokgo').onclick = () => { TOKEN = $('#tok').value.trim(); load(); };
$('#tok').addEventListener('keydown', e => { if (e.key === 'Enter') $('#tokgo').click(); });
load();
</script>
</body></html>`;
