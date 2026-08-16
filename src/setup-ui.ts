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
 */

export const SETUP_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InferenceMesh — セットアップ</title>
<style>
:root{--bg:#fff;--fg:#16171a;--mut:#63666e;--line:#e4e5e9;--ok:#0a7a3f;--bad:#b3261e;--acc:#1a56db;--card:#fafafb}
@media(prefers-color-scheme:dark){:root{--bg:#111214;--fg:#e8e9ec;--mut:#9b9ea6;--line:#2a2c31;--ok:#4ade80;--bad:#f87171;--acc:#7aa2f7;--card:#17181c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
.wrap{max-width:780px;margin:0 auto;padding:2rem 1.1rem 5rem}
h1{font-size:1.5rem;margin:0 0 .3rem}
.sub{color:var(--mut);margin:0 0 1.5rem}
.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;margin:0 0 1.5rem;font-size:.9rem}
.note b{color:var(--fg)}
.note ul{margin:.5rem 0 0;padding-left:1.1rem}
.p{border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;margin-bottom:.9rem;background:var(--card)}
.p h2{font-size:1.05rem;margin:0 0 .2rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.tag{font-size:.7rem;padding:.15rem .45rem;border-radius:99px;border:1px solid var(--line);color:var(--mut);font-weight:400}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.desc{color:var(--mut);font-size:.9rem;margin:0 0 .6rem}
ol{margin:.4rem 0 .8rem;padding-left:1.3rem;font-size:.9rem}
ol li{margin:.15rem 0}
a{color:var(--acc)}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
input{flex:1;min-width:15rem;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;font-size:.9rem}
button{padding:.55rem 1rem;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-size:.9rem;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.msg{font-size:.85rem;margin-top:.5rem;min-height:1.2em}
.msg.ok{color:var(--ok)}
.msg.bad{color:var(--bad)}
.hint{color:var(--mut);font-size:.8rem;margin-top:.35rem}
.done{opacity:.65}
#gate{padding:1rem;border:1px solid var(--bad);border-radius:10px;margin-bottom:1.5rem}
.foot{color:var(--mut);font-size:.85rem;margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem}
code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:.05rem .3rem;font-size:.85em}
</style>
</head>
<body><div class="wrap">
<h1>InferenceMesh — セットアップ</h1>
<p class="sub">無料のAIモデルを使えるようにします。クレジットカードは要りません。</p>

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
  <div class="row"><input id="tok" type="password" placeholder="アクセストークン"><button id="tokgo">続ける</button></div>
  <div class="msg" id="tokmsg"></div>
</div>

<div id="list"></div>

<div class="foot" id="foot"></div>
</div>
<script>
// The token arrives in the URL fragment. Fragments are never sent to a server
// and never land in an access log, which a query string would.
let TOKEN = location.hash.slice(1);
const $ = (s, r) => (r || document).querySelector(s);

async function api(path, opts) {
  const r = await fetch(path, Object.assign({headers:{'authorization':'Bearer '+TOKEN,'content-type':'application/json'}}, opts||{}));
  if (r.status === 401) throw new Error('unauthorized');
  return r.json();
}

function providerCard(p) {
  const el = document.createElement('div');
  el.className = 'p' + (p.configured || p.keyless ? ' done' : '');
  const steps = (p.signupSteps && (p.signupSteps.ja || p.signupSteps.en)) || [];
  const state = p.keyless ? '<span class="tag ok">鍵なしで使えます</span>'
              : p.configured ? '<span class="tag ok">設定済み</span>' : '';
  el.innerHTML =
    '<h2>' + esc(p.id) + state + '</h2>' +
    (p.summary ? '<p class="desc">' + esc(p.summary) + '</p>' : '') +
    (p.freeTierNote ? '<p class="desc">' + esc(p.freeTierNote) + '</p>' : '') +
    (p.configured || p.keyless ? '' :
      (steps.length ? '<ol>' + steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '') +
      (p.signupUrl ? '<p><a href="' + esc(p.signupUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(p.signupUrl) + ' を開く →</a></p>' : '') +
      '<div class="row">' +
        (p.accountIdEnv ? '<input class="acct" placeholder="Account ID">' : '') +
        '<input class="key" type="password" placeholder="ここに鍵を貼る' + (p.keyPrefix ? '（' + esc(p.keyPrefix) + '… で始まります）' : '') + '">' +
        '<button class="go">確認して保存</button>' +
      '</div>' +
      '<div class="msg"></div>');
  if (!p.configured && !p.keyless) {
    const btn = $('.go', el), key = $('.key', el), acct = $('.acct', el), msg = $('.msg', el);
    btn.onclick = async () => {
      const value = key.value.trim();
      if (!value) return;
      // Shape check before spending a network round trip: catches "copied the
      // wrong string off the page", which is the common mistake.
      if (p.keyPrefix && !value.startsWith(p.keyPrefix)) {
        msg.className = 'msg bad';
        msg.textContent = 'この鍵は ' + p.keyPrefix + ' で始まるはずです。別の文字列をコピーしていませんか？';
        return;
      }
      btn.disabled = true; msg.className = 'msg'; msg.textContent = '確認しています…';
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
  }
  return el;
}

function esc(s){const d=document.createElement('div');d.textContent=String(s);return d.innerHTML;}

async function load() {
  try {
    const d = await api('/v1/providers');
    const list = $('#list'); list.innerHTML = '';
    for (const p of d.providers) list.appendChild(providerCard(p));
    $('#foot').textContent = 'いま使えるモデル: ' + d.candidates + ' 件（' + d.usable.join(', ') + '）';
    $('#gate').hidden = true;
  } catch (e) {
    if (String(e.message) === 'unauthorized') { $('#gate').hidden = false; $('#list').innerHTML = ''; }
    else $('#foot').textContent = String(e.message || e);
  }
}

$('#tokgo').onclick = () => { TOKEN = $('#tok').value.trim(); load(); };
$('#tok').addEventListener('keydown', e => { if (e.key === 'Enter') $('#tokgo').click(); });
load();
</script>
</body></html>`;
