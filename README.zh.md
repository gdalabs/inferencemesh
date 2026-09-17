# InferenceMesh

**[English](README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · 中文**

一个 OpenAI 兼容的路由器，**按请求**挑选 LLM 提供方——依据成本、能力、语言、机密级别、
剩余免费额度和实测健康状况，并在某一家不可用时自动转到下一家。

你的应用只要请求 `mesh/free` 或 `mesh/best`。至于实际作答的是 Groq、Gemini、
Cloudflare Workers AI 还是 OpenRouter，应用永远不需要知道。

```
POST /v1/chat/completions   { "model": "mesh/free", "messages": [...] }
                                        │
                          路由 → 调用 → 回退 → 记账
                                        │
              Groq · Gemini · Workers AI · OpenRouter · 任何 OpenAI 形状的服务
```

- **零依赖，零厂商 SDK。** 只用 `fetch`。同一份产物可在 Node 20+ / Cloudflare Workers /
  Deno / Bun 上运行
- **BYOK（密钥归你）。** 密钥从环境变量读取。缺少密钥的提供方在加载时被剔除，并在
  `warnings` 中列出名字——**绝不会悄悄消失**
- **免费额度是主角。** 配额账本按模型统计每分钟、每天的请求数和每天的 token 数，
  额度用尽的提供方会在拿到 429 之前就被跳过
- **机密级别是过滤条件，不是偏好。** 标记为 `confidential` 的请求，无论评分多高，
  都不会被路由到只支持 `internal` 的提供方
- **MIT。** 路由器是开放的。你**连接到什么**，以及如何使用这些回答，是你自己的事

### 有什么不同

把免费额度聚合起来的路由器并不是新想法。[`docs/prior-art.md`](docs/prior-art.md) 读了其中九个，
并且先写明了**本项目的哪些想法并不原创**：免费额度的记账不原创，按敏感度路由也不原创。
真正少见的只有三点。

- **不会回退到付费模型。** 调查过的网关无一例外把付费回退当作卖点。这里免费额度用尽就是错误，
  因为依赖免费额度的人，恰恰最难察觉账单正在产生
- **没有任何方式把已保存的密钥读出来。** `KeyStore` 没有 `get`。不是加密存储，而是**根本没有出口**。
  没有端点会返回它，也没有任何地方把它写进日志
- **注册表里没有一个数字是猜的。** 没有验证日期的非零价格会被校验拒绝；没有 probe 过的能力不会被声明。
  这类错误不会报错，只会悄悄改变路由顺序——所以用机器强制，而不是靠人工评审

---

## 不用密钥、不用注册就能开始

```sh
INFERENCEMESH_TOKENS=$(openssl rand -hex 32) docker compose up
```

这就是全部。**在完全没有提供方密钥的情况下**，网格依然能路由，因为有些提供方运营着无需
密钥的免费层——已端到端验证：一个环境变量为空的容器能够回答真实的聊天请求。

compose 会读取放在它旁边的密钥文件，所以 `inferencemesh setup` 已经写入的密钥无需在任何地方
再列一遍就会进入容器。**这一点在两个方向上都值得知道**：它解释了容器为什么拥有你的密钥，
也解释了那个文件为什么绝不能提交到版本库。

```sh
curl localhost:8910/v1/chat/completions \
  -H "authorization: Bearer $INFERENCEMESH_TOKENS" \
  -H 'content-type: application/json' \
  -d '{"model":"mesh/free","messages":[{"role":"user","content":"hello"}]}'
```

加上密钥会更好。启动时会打印一个地址：

```
[inferencemesh] add keys here: http://127.0.0.1:8910/setup#<token>
```

片段中的 token 就是你自己设置的 `INFERENCEMESH_TOKENS` 之一。从终端启动时，这一行是完整、
可点击的；但只要输出会变成日志（systemd 之下、`docker compose` 之下），**token 就会被省略**
——不把凭据写到一个比进程活得更久、且不止启动者能读的地方。

设置页面会列出每个提供方给你什么、**一步一步怎么拿到密钥**、密钥长什么样（`nvapi-…`）、
一个粘贴框，以及一次实时校验。验证通过的密钥立即生效，无需重启。

每一步都配有**那一屏的示意图**。图是从步骤文字本身画出来的：「」中的文字就是要按的控件，
所以图里高亮的正是它。所有图都标注为示意图——把画出来的东西当作截图展示，是在关于
"这张图是什么时候的" 这件事上撒谎（控制台会改版，而图只会留在原地变旧）。

有真实截图时以真实截图为准。把 `groq-1.png` 放进 `.inferencemesh/shots`，Groq 的第一步就会
显示它。这些图片与其余 API 一样需要**同一个 token** 才能取得——你自己控制台的截图角落里
往往有你的账号名——并且是 fetch 成 blob 后显示，因为 `<img src>` 无法携带 Authorization 头。

**你的密钥不会离开你的机器。** 不存在任何托管组件。密钥只去两个地方：你自己卷里的一个 `600`
文件，以及签发它的那家提供方。**没有任何接口能返回已保存的密钥**——`/v1/providers` 只报告
"有没有"——而且**它不会被写进日志**。这不是口头承诺，而是由测试强制的。

`inferencemesh setup` 在终端里做同样的事：说明每家提供方给你什么，打印领取密钥的页面，并且
**在保存之前用一次真实请求验证密钥**——因为当一个打错的密钥和一个能用的密钥保存得一样顺利
时，"已保存！" 并不能让人安心。

### 免费的真实代价

免费是一笔交易，而条款很少被摊开来说。`setup` 在向你索要任何东西之前就先展示这些：

- **你的提示词可能被用于训练提供方的模型。** 不要发送私人信息、医疗信息或他人的个人数据
- **绝不要把密钥发到浏览器或手机 App 里。** 把它放在服务端；这个网关就是那个服务端
- **没有可用性承诺。** 免费层随时可能被撤销，且不会提前通知
- **有些免费模型会把推理过程直接说出来**（"The user asks…"）。那是模型的行为，不是你代码的 bug
- **这个网关绝不会自动回退到付费模型。** 免费额度用尽时返回错误，所以一次失误不会变成账单

## 安装

一个可执行文件，不需要 Node，也不需要包管理器：

```sh
curl -fsSL https://raw.githubusercontent.com/gdalabs/inferencemesh/main/install.sh | sh
```

它会下载适配你平台的构建产物，**对照公布的 `SHA256SUMS` 校验，校验不了就拒绝安装**——
一个"任何能替换二进制的人也能顺手关掉"的校验，根本不算校验。安装位置是 `~/.local/bin`；
`INFERENCEMESH_BIN_DIR` 可以改变它，`INFERENCEMESH_RELEASE_BASE` 可以指向镜像或离线副本，
`INFERENCEMESH_SKIP_CHECKSUM=1` 可以跳过校验——但你应该为此有个理由。

作为库使用，或从源码运行：

```sh
npm install inferencemesh
```

需要 Node 20 或更高。没有需要审计的运行时依赖——容器镜像里只有编译产物。

## 作为库使用

```ts
import { InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from './providers.default.json' with { type: 'json' };

const mesh = new InferenceMesh({ registry: registryFrom(registryFile) });

const res = await mesh.chat({
  model: 'mesh/free',
  messages: [{ role: 'user', content: '请用中文回答' }],
  mesh: { language: 'zh', privacy: 'public' },
});

console.log(res.choices[0].message.content);
console.log(res.mesh);
// { served_by: 'gemini/gemini-2.5-flash', profile: 'free',
//   attempts: [{ key: 'groq/llama-3.3-70b-versatile', status: 429, ... }],
//   latency_ms: 812, cost_usd: 0 }
```

`res.mesh.attempts` 会列出路上试过并失败的每一次。**什么都不隐藏**：如果某家提供方返回了
429、请求悄悄换了地方，它会如实写出来。

## 作为网关使用

```sh
export GROQ_API_KEY=...            # 至少一家提供方
export INFERENCEMESH_TOKENS=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npx inferencemesh serve
```

然后把任意 OpenAI 客户端指过来——这一点在 2026-08-22 用**官方 `openai` 包实测过**，不是
口头声明：`models.list()`、带 usage 的补全、流式补全，以及一个拼错的 profile 会以
**`BadRequestError`（400）** 而不是客户端会去重试的形式返回。

| 路由 | 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容，支持流式与非流式 |
| `GET /v1/models` | mesh profile，以及每一个具体的 `provider/model` |
| `GET /healthz` | 熔断器状态、配额计数、加载时的告警 |

服务器在**没有认证 token 时拒绝启动**，也**拒绝绑定 `0.0.0.0`**（除非你显式覆盖）。这个进程
握着你拥有的每一把提供方密钥；共享网络上一个敞开的 LLM 中继，就是别人拿你的免费额度做推理的
装置。请在它前面放 `tailscale serve` 或反向代理。

### 在名称外发之前将其遮蔽

免费套餐会保留提示词。若有不希望被用于训练的词，请在 `mesh.mask` 中列出：

```sh
curl localhost:8910/v1/chat/completions \
  -H "authorization: Bearer $INFERENCEMESH_TOKENS" \
  -H 'content-type: application/json' \
  -d '{"model":"mesh/free","messages":[{"role":"user","content":"Will Tanaka Corp merge with Sato?"}],"mesh":{"mask":["Tanaka Corp","Sato"]}}'
```

每个词在本机被替换为按请求生成的别名，只发送别名化后的提示词（重试也复用同一份，
不会重发原文）。响应中的别名会在返回前还原。对照表绝不会离开本进程。

保证是有意收窄的：字面上的词不会外发。句子结构、话题以及发起过询问这一事实本身仍会
外发。与 `stream: true` 并用会被400拒绝——跨流式分片的别名目前还无法如实还原。

### 在编辑器里使用

| 客户端 | 是否可用 | |
|---|---|---|
| [OpenCode](https://opencode.ai) | **可用** | 已实际跑通验证 |
| 任何 OpenAI 兼容的客户端与 SDK | **可用** | `/v1/chat/completions` 就是全部契约 |
| [Codex CLI](https://github.com/openai/codex) | **不可用** | 需要 `/v1/responses` |
| [Claude Code](https://code.claude.com) | **不可用** | 需要 Anthropic Messages API |

各自的配置方法，以及这张表背后的实测，都在 [`docs/clients.md`](docs/clients.md)。
**不可用**的两行是**实际连上去让它失败**得出的，不是读文档推断的——两个工具事先都不会告诉你。

### 在 Cloudflare Workers 上

`handleRequest` 就是一个普通的 Fetch 处理器，所以一个 Worker 就是全部集成。它的真身是
[`examples/worker.ts`](examples/worker.ts)，**由构建过程编译**——只活在 README 里的代码片段，
是没有人真正运行过的代码片段。

```ts
import { handleRequest, InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from './providers.json';

/**
 * 绑定。索引签名让整个 env 可以直接交给 registry 作为密钥来源
 * （每家提供方会自己声明它需要的变量名，所以这里不必逐个列出）。
 */
interface Env {
  GATEWAY_TOKENS: string;
  [key: string]: string | undefined;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const mesh = new InferenceMesh({ registry: registryFrom(registryFile, { env }) });
    return handleRequest(req, { mesh, tokens: new Set(env.GATEWAY_TOKENS.split(',')) });
  },
};
```

如果希望配额在 isolate 轮换后仍然有效，请用 KV 或 Durable Object 实现 `LedgerStorage`。默认的
内存实现会随 isolate 一起消失，从而在每日上限面前少算。

---

## 如何指定模型

| `model` | 含义 |
|---|---|
| `mesh/free` | 在该 profile 内路由 |
| `mesh/best`、`mesh/cheap`、`mesh/fast`、`mesh/coding`、`mesh/vision`、`mesh/private` | 内置 profile |
| `groq/llama-3.3-70b-versatile` | 固定（pin）到某一个候选 |

pin 会覆盖 profile 的**价格**偏好，但**不会**覆盖机密级别、能力和上下文这些过滤条件——
不能用 pin 把机密文本夹带到 public 级别的提供方。

按请求的覆盖项放在 `mesh` 对象里，它在到达任何提供方之前会被剥离：

```json
{
  "model": "mesh/best",
  "messages": [],
  "mesh": {
    "language": "zh",
    "privacy": "confidential",
    "capabilities": ["vision"],
    "minContext": 100000
  }
}
```

## 候选是怎么选出来的

**硬过滤**（正确性问题——被排除的候选无论得分多高都出局）：
机密级别 · 必需能力 · 上下文长度 · profile 的价格上限。

**加权评分**（偏好问题——每个 profile 的权重不同）：
`quality` · `cost` · 实测 `latency` · `language` 能力。

**然后依次是**：熔断器打开的候选被剔除（除非这会让候选池变空——一个大概率挂了的提供方，
仍然好过没有提供方），在真正调用时检查配额，剩下的排序结果就是回退链。

`inferencemesh route best --language=zh` 会打印完整的决策过程，包括每个被淘汰的候选**为什么**
被淘汰，而且**完全不碰网络**。请求可以携带的过滤条件在这里都是命令行参数，所以在接线之前就能
回答路由问题：

```sh
inferencemesh route best --language=zh
inferencemesh route free --capabilities=vision,tools   # 硬性要求，不是偏好
inferencemesh route best --privacy=confidential        # 候选必须满足的下限
inferencemesh route free --min-context=200000
```

如果传入的不是真实存在的能力、机密级别或数字，会被**指名拒绝**，而不是悄悄把所有候选都
过滤掉——一个笔误应该读起来像笔误，而不是像一个空的注册表。

### **不会**重试的情况

`400` 或 `422` 是请求本身的问题，在每一家提供方都会以同样的方式失败，所以链条立即停止。
`401` **会**重试，因为下一家提供方并不共用这把出错的密钥。

### 同时能跑多少

限流有两种形态，其中**只有一种是时间窗**。`quota` 统计每分钟和每天的请求数；
`maxConcurrent` 统计**此刻正在进行**的请求数。一家一次只服务一个请求的提供方，会在每分钟
预算几乎没动用的情况下把并发扇出打成 429——只数时间窗是看不见这件事的。

```jsonc
{ "id": "some-provider", "maxConcurrent": 2, "models": [ /* ... */ ] }
```

它的作用域是**提供方**而不是模型：上限属于那份凭据，所以同一把密钥后面的两个模型共享账号的
名额。

`quota` 也可以放在同一个位置，理由相同。写着"每分钟 10 次请求"的免费额度，几乎总是针对
**密钥**而不是每个模型。把这个数字写到三个模型上，就等于放行了三十次；随之而来的 429 与
任何其他失败毫无区别，网格会悄悄转向下一家提供方，而这个配置错误始终浮不上来。在提供方
上写一次，它就会先于模型自身的预算被预留，并与之一同退还。

```jsonc
{ "id": "orcarouter", "quota": { "requestsPerMinute": 10, "requestsPerDay": 50 } }
```

把账号的十次按模型平分成每个三次，正是 `maxConcurrent` 拒绝去做的那种猜测：它凭空造出提供方
从未声明过的单模型上限，一旦流量不均，就会掐住真实容量。

繁忙的提供方会被**跳过而不是等待**——转到空闲的那一家，正是这条链存在的意义。只有当**每一个**
候选都在忙时，请求才会排队（FIFO），最多等待 `INFERENCEMESH_CONCURRENCY_WAIT_MS`
（默认 30000；设为 `0` 则直接失败）。那是只有一家提供方时的情形：现在就返回 503，比稍等片刻
拿到答案更糟。

不写 `maxConcurrent` 就表示不限。一个没人实测过的上限，等于凭猜测掐住真实容量，所以随包
发布的注册表只在**实测过的地方**才写：`llm7` 是 **1**——2026-08-22 通过不断提高并发度、
直到第二个进行中的请求返回 `429 Too many concurrent requests for this client` 找到，并复现
了三次。用同样的方法找出你自己的值，或者查提供方文档——**并把日期写在旁边**。

## 配置

所有设置都是环境变量；服务器不读取自己的配置文件。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `INFERENCEMESH_TOKENS` | *(无)* | 逗号分隔的 Bearer token。**没有任何一个时服务器拒绝启动**——一个不需要认证的 LLM 中继，就是别人在用你的免费推理 |
| `INFERENCEMESH_PORT` | `8910` | 监听端口 |
| `INFERENCEMESH_HOST` | `127.0.0.1` | 绑定的网卡。绑定 `0.0.0.0` 还需要 `INFERENCEMESH_ALLOW_ANY_HOST=1`，因为这个进程握着你所有的提供方密钥 |
| `INFERENCEMESH_ALLOW_ANY_HOST` | 未设置 | 允许绑定到非回环地址。在容器里设置（网络命名空间就是边界）；在其他地方请三思 |
| `INFERENCEMESH_ALLOWED_ORIGINS` | *(无)* | 允许从浏览器直接调用的源（逗号分隔）。为空则完全不输出 CORS 头 |
| `INFERENCEMESH_PUBLIC_HEALTH` | 未设置 | `1` 表示 `/healthz` 不需要 token。它会暴露提供方 ID、熔断状态和配额——对可用性监控有用，但也不是可以随便给出去的东西 |
| `INFERENCEMESH_REGISTRY` | *(自动查找)* | 注册表文件路径。**指定一个不存在的路径会报错**，而不是悄悄回退到内置副本 |
| `INFERENCEMESH_KEYS` | `.inferencemesh/keys.env` | 通过设置页面添加的密钥的存放位置，权限 600 |
| `INFERENCEMESH_SHOTS` | `.inferencemesh/shots` | 设置指引的截图目录，命名为 `<provider>-<n>.png`。没有也没关系——页面会自己画图 |
| `INFERENCEMESH_LEDGER` | `.inferencemesh/ledger.json` | 配额计数。**请放在卷上**，否则每次重启都会忘记这一天已经花掉多少 |
| `INFERENCEMESH_CONCURRENCY_WAIT_MS` | `30000` | 当*每一个*候选都在忙时排队等待的时长。`0` 表示不等待、直接失败 |
| `INFERENCEMESH_LANG` | *(系统语言)* | 设置向导的语言（`ja` / `en`），默认取系统 locale |

提供方密钥各有自己的变量，由每条记录的 `apiKeyEnv` 指定——`GROQ_API_KEY`、
`OPENROUTER_API_KEY` 等等。缺少密钥的提供方会被跳过，并在 `/healthz` 中列名。

## 生成注册表

手写的注册表，是一个按周变化的市场的快照；手写的价格，是关于一个已经过去的日子的断言。
`sync` 读取提供方自己的目录，只写机器能够知道的那部分。

```sh
inferencemesh sync --provider=redpill    --out=providers.local.json --dry-run
inferencemesh sync --provider=openrouter --out=providers.local.json --dry-run
inferencemesh sync --provider=nous       --out=providers.local.json --dry-run
```

OpenRouter 和 Nous Portal 的目录都**不需要密钥**，这使它们成为不消耗任何人额度就能刷新的两个
来源。两者都只按免费层读取：OpenRouter 在 2026-08-22 时 421 个模型中有 22 个价格为零；
Nous 在 2026-08-28 时 371 个模型中有 5 个在每一层都为零。

这里的"免费"指的是**公布的每一项价格都为零**，而不只是按 token 的那两项。pricing 对象里还有
`web_search`、`image`、各种缓存键，以及真正会让人栽跟头的 `overrides`——一组分时段的价格窗口。
一个按 token 报零、却在 UTC 06:00 到 24:00 之间收费的模型不是免费，而是**看起来免费**。
这在 2026-08-28 不再是假设：`tencent/hy3:free` 顶层报零，却用两个窗口覆盖了一整天。

### 匿名预览不是能进注册表的东西

OpenRouter 的 `stealth/` 命名空间，是在不说明归属的情况下提供一个尚未发布的模型。自 2025 年
4 月以来共 14 个——GPT-4.1、GPT-5、Grok 4 Fast、小米的 MiMo、美团的 LongCat 都从这里经过——
中位数运行 4 到 12 天，然后**这个 ID 消失，模型以真实名字发布**。免费，但注定腐烂。因此
`sync` 干脆**拒绝把它们写进 `providers.default.json`**，每次运行都在告警里指名，并以
`maxPrivacy: "public"` 生成它们，因为运营者是匿名的，而且会保留你的提示词。

日期字段在这里救不了你。2026-08-25 时 `stealth/ox-alpha` 带的是
`expiration_date: 2098-12-31`——那是表示**"未宣布结束"的哨兵值**——而这类条目整个形式只持续
两周左右。**我们唯一一个机器可读的告警信号，恰恰对最确定会消失的条目说了"永不结束"。**
所以这里用的是一个专门的标记，而不是去信任那个日期。

`sync` 需要新建的提供方条目会以 `maxPrivacy: "public"`（最低级别）生成，并且明确告知。生成
`internal` 等于让 sync 替你决定一家提供方可以被托付什么——而这正是它对已存在条目坚决不做的
判断，却在新条目上悄悄做了。

绝不写入的：`quality` 和 `languages`。目录不知道一个模型好不好，也不知道它能不能用中文对话；
在那里填一个看起来合理的数字，会悄悄重排 `best` profile 的顺序，并让每一个非英语用户都得到
更差的结果——这和一个未经核实的价格是同一类错误，而且连账单这样的纠错手段都没有。新条目
生成时就是**未评级**的，在你亲自评级之前按中性计分。

同样绝不写入的：已存在条目上的 `maxPrivacy`。拿目录去对比，无法区分"是人把它调高了"还是
"是厂商把它调低了"，而这两者需要完全相反的应对。目录所支持的级别被单独记录在
`evidencePrivacy` 里，并**与目录自己上一次的答案**做比较。如果你的文件允许的级别高于目录所
支持的，`sync` 会以非零退出——直到你把级别调低，或者记下 `privacyVerifiedAt`。而且**只要目录
自己的答案发生变化，它就会再次报警**，因为那正是旧的签字失效的时刻。

从目录中消失的模型会被**停用而不是删除**。删除会丢掉你写下的评级，也会让"它消失了"这件事在
下一次比对中变得不可见。

### 唯一一个提前到达的警告

关于腐烂的一切通常都是事后才知道的——由一个正在等回复的用户发现。`expiration_date` 是例外：
它是提供方以机器可读的形式宣告"这个免费层将在某天结束"。`sync` 把它记为 `expiresAt`，并在
60 天以内时发出告警——写下这段话的时候，nvidia 的三个 `:free` ID 距离到期只剩两天。

`probe` 和 `route` 也会显示它，因为 sync 的报告只在重新生成注册表时才会被读到，而那并不是你
想知道"某个你正在路由过去的模型下周一就没了"的时刻。

它不参与任何路由决策。日期是一种意图声明而非观测结果，一个活过了自己宣告期限的模型，应该
继续服务，而不是被一个 JSON 文件里的算术剔除。

### 目录无法告诉你的事

**"没有写"不等于"否定"。** RedPill 上有 14 个模型完全没有声明能力，其中 6 个跑在 TEE 上，而
其中至少一个能完好地处理工具调用。sync 对它们只记录 `text` 并发出告警；它**绝不会写下没有
任何人主张过的"不支持工具"**，也不会覆盖你实测后写下的能力。

最后这一点比听起来要窄，值得说准确：目录拥有的只是**它真正能表达的那些能力**——`text`、
`vision`、`tools`、`json`——仅此而已。**没有任何目录能描述 `code`。** 整体覆盖能力列表，会
让一个毫无变化的模型丢掉手写的 `code`，而 `mesh/coding` 从此看不见它。目录刷新它观测到的
部分，但没有权限抹掉它看不见的部分。

`is_tee: true` 只能换来 `internal`，永远换不来 `confidential`。那不过是厂商在一个 JSON 字段
里关于自己的声明，没有任何人验证过远程证明；而且在 RedPill 上，TEE 的运营者常常并不是你以为
的那一家——`providers` 列表里还有 `chutes`、`near-ai`、`tinfoil`、`secretai`，一个同时列出
好几家的模型，并没有给调用方任何选择的余地。

## 让注册表保持诚实

`providers.default.json` **只发布免费层、只发布价格为 0 的条目**——因为 0 是关于一家提供方的
数字里，**唯一一个不会以骗人的方式过期的数**。付费模型是刻意不发布的：价格会在不通知的情况
下变化，而一个过期的价格不会大声失败，它只会悄悄重排 `cheap` profile 的顺序。请复制
`providers.example.json`，填进**你自己核实过的价格**。

模型 ID 和免费层**确实会腐烂，而且是悄悄地**，第一个症状就是一个正在等回复的用户。把这件事
变成一个退出码：

```sh
inferencemesh version          # 这是哪个构建
inferencemesh probe            # 把每个候选都调用一次
inferencemesh probe --json     # 给调度器用；同时携带 `ending`
```

`probe` 会区分两个看起来相似、实则完全不同的发现：`404`/`400` 意味着这个 ID 没了，需要人来
处理（`BROKE`，退出码 1）；`429` 意味着免费层正按设计工作（`limit`，退出码 0）。每天夜里为
后者报警，正是教会一个人从此忽略监控的方式。

`quality` 和 `languages` 是手工维护的**相对估计**，不是基准测试结果——它们只需要把**你的**
注册表排对顺序。不过 `languages` 这一半，至少**可以被证据反驳**：

```sh
inferencemesh probe --language=zh          # 用中文提问，给回答打分
inferencemesh probe --language=zh --json
```

能够判定的是那些仅凭文字系统就能确定的语言——日语（会看假名，所以中文不会被当成日语通过）、
中文、韩语、俄语、阿拉伯语、印地语、泰语、希伯来语、希腊语、亚美尼亚语、格鲁吉亚语、孟加拉语、
泰米尔语——外加 11 种依靠功能词区分的拉丁字母语言。其余一律报告为 `unjudged`（无法判定），
而不是判为失败。

对于共用同一文字系统的语言，还会检查**区分它们的字符**：一段乌克兰语的回答不能用来确认关于
俄语的声明，波斯语也不会被当成阿拉伯语通过；`zh-Hant` 不能用简体字来回答——而单独的 `zh` 两
者都接受，因为它并没有要求其中任何一种。这项检查**只能用于否定，绝不用于臆断**：一段不含任何
区分性字符的回答，保留按文字系统得出的判定；而同时含有两种语言各自专属字符的回答，会被当作
"没有证据"而不是一个发现。至今仍无法区分的，是那些根本没有区分字符的组合（印地语与马拉地语）。

每个候选会被问两个**用该语言写成的**问题——用英文说"请用中文回答"测的是指令遵循而不是语言
本身——然后按文字系统和功能词给回答打分。结果会与注册表的声明并排打印，而且**只有一个方向
算作故障**：注册表声称支持、而模型不肯用该语言作答（退出码 1）。一个被低估却回答得很好的模型
会被报告为 `understated`——值得一读，但不值得叫醒任何人。

如果一次运行中每个候选都不可达或都被限流，报告的是 **`nothing was measured`（什么都没测到）**
而不是 `no contradictions`（没有矛盾）；`--json` 会在 `ok` 旁边带上 `judged` 计数，因为
**零次测量之上的 `ok: true`，是最具误导性的绿灯**。

**它从不写入分数。** 用中文作答体现的是 compliance（是否照做），而不是 competence（做得多好）；
把一次通过变成 `0.84`，等于**把一个编造的数字放进本该是实测值的位置**——和一个未经核实的价格
是同一种失败。判定不了的，它就说判定不了：没有判定器的语言、短到无法与邻近语言区分的回答、
以及被 token 上限从思考中途截断的回答，都会返回 `unjudged` 而不是失败。最后这一种并非假设——
这个命令的第一次真实运行，就把一个模型判成了"日语失败"，而它当时正在用英文思考"应该用日语
回答"。

## 发现新的提供方

新入场者是有意把推理免费送出去的——那是获客，不是慈善——所以今天最好的免费层，往往在你写下
注册表的时候还不存在。一份手写的清单，在发布的当月就已经过时。

```sh
node scripts/discover-providers.mjs        # 有新东西时退出码为 10
node scripts/discover-providers.mjs --json
```

它会把每家提供方自己的 `/v1/models` 与上一次运行做比对（既捕捉新增，也捕捉**会真正弄坏你注册
表的下架**），并扫描 Hacker News 和高星的社区清单。所有来源都不需要密钥，因为一个需要密钥的
来源，会恰好在你不再关注它的时候停止工作。发现的是候选：在加入任何东西之前先用 `probe` 确认。

## 完全不需要密钥的提供方

一家提供方可以声明 `apiKeyOptional: true`，此时即使没有任何凭据它也会被加载，并且适配器
**不会**发送 `Authorization` 头——有些网关会把空的 `Bearer ` 判为格式错误而拒绝，那看起来
和一把错误的密钥一模一样。

这让零注册部署成为可能：在环境变量为空的情况下，网格依然能只靠开放层的提供方完成路由。在随包
发布的注册表里，这类提供方被固定为 `maxPrivacy: "public"`，**也应该保持如此**——一个任何人
都能匿名调用的端点，不是你该往里发送"被记下来会介意的东西"的地方。

## 开发

```sh
npm test        # 先构建，再运行整套测试（不需要网络，不需要密钥）
npm run build
```

测试套件中的每一条失败路径，都是用**故意弄坏的输入**跑通过的——一个畸形的注册表、一个空的
token 集合、一个从 JSON 中间截断的流式分块、一个已经过期的配额窗口——因为**一条从未触发过的
检查，并不能算是已知可用的检查**。

## 许可证

MIT © GDA Labs
