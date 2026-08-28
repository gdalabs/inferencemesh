# InferenceMesh

**[English](README.md) · [日本語](README.ja.md) · 한국어 · [中文](README.zh.md)**

요청마다 LLM 제공자를 고르는 OpenAI 호환 라우터. 비용·기능·언어·기밀성·남은 무료 한도·
관측된 상태를 기준으로 고르고, 하나가 죽으면 다음으로 넘어갑니다.

애플리케이션은 `mesh/free`나 `mesh/best`를 요청할 뿐입니다. 실제로 답한 것이 Groq인지
Gemini인지 Cloudflare Workers AI인지 OpenRouter인지는 알 필요가 없습니다.

```
POST /v1/chat/completions   { "model": "mesh/free", "messages": [...] }
                                        │
                          라우팅 → 시도 → 폴백 → 기록
                                        │
              Groq · Gemini · Workers AI · OpenRouter · OpenAI 형식이면 무엇이든
```

- **의존성 0, 제공자 SDK 0.** `fetch`만 씁니다. 같은 번들이 Node 20+ / Cloudflare Workers /
  Deno / Bun에서 그대로 돌아갑니다
- **BYOK(키는 당신 것).** 키는 환경 변수에서 읽습니다. 키가 없는 제공자는 로딩 시점에
  제외되고 `warnings`에 이름이 남습니다. **조용히 사라지지 않습니다**
- **무료 한도가 주인공.** 할당량 원장이 분당·일당 요청 수와 하루 토큰 수를 모델 단위로 세어,
  소진된 제공자는 429를 받기 전에 건너뜁니다
- **기밀성은 취향이 아니라 필터.** `confidential` 요청은 점수가 아무리 높아도
  `internal`까지만 지원하는 제공자로 가지 않습니다
- **MIT.** 라우터는 공개입니다. 무엇에 **연결할지**와 그 답을 어떻게 쓸지는 당신의 몫입니다

---

## 키도 가입도 없이 시작하기

```sh
INFERENCEMESH_TOKENS=$(openssl rand -hex 32) docker compose up
```

이게 전부입니다. **제공자 키가 하나도 없어도** 메시는 라우팅합니다. 키 없이 열려 있는
무료 한도를 제공하는 곳이 있기 때문입니다 — 실측 완료: 환경 변수가 빈 컨테이너가 실제
채팅 요청에 응답합니다.

compose는 옆에 있는 키 파일을 읽습니다. `inferencemesh setup`으로 저장한 키는 어디에도
적지 않아도 컨테이너로 전달됩니다. **양방향으로 알아둘 일입니다**: 컨테이너가 당신의 키를
갖게 되는 이유이자, 그 파일을 절대 커밋하면 안 되는 이유입니다.

```sh
curl localhost:8910/v1/chat/completions \
  -H "authorization: Bearer $INFERENCEMESH_TOKENS" \
  -H 'content-type: application/json' \
  -d '{"model":"mesh/free","messages":[{"role":"user","content":"hello"}]}'
```

키를 넣으면 더 좋아집니다. 시작할 때 URL이 출력됩니다:

```
[inferencemesh] add keys here: http://127.0.0.1:8910/setup#<token>
```

프래그먼트의 토큰은 당신이 설정한 `INFERENCEMESH_TOKENS` 중 하나입니다. 터미널에서 실행하면
그대로 클릭할 수 있게 출력되지만, **출력이 로그가 되는 곳**(systemd 아래, `docker compose`)
에서는 **토큰을 빼고** 출력합니다 — 프로세스보다 오래 남고 실행한 사람 말고도 읽을 수 있는
곳에 자격 증명을 남기지 않기 위해서입니다.

설정 화면에는 제공자마다 무엇을 주는지, **키를 얻는 단계별 절차**, 키의 생김새(`nvapi-…`),
붙여넣는 칸, 그리고 즉석 확인이 있습니다. 확인된 키는 바로 반영됩니다. 재시작은 필요 없습니다.

각 단계에는 **그 화면의 그림**이 붙습니다. 그림은 단계 문장 자체에서 그려집니다 — 「」 안의
문구가 눌러야 할 컨트롤이므로 그 부분을 강조합니다. 모두 "이미지 그림"이라고 명시되어
있습니다. 그림을 스크린샷처럼 보이게 하는 것은 그 그림이 언제 정보인지에 대해 거짓말을 하는
일이기 때문입니다(콘솔은 개편되고 그림만 낡은 채로 남습니다).

실제 스크린샷이 있으면 그쪽이 우선합니다. `.inferencemesh/shots`에 `groq-1.png`를 넣으면
Groq의 첫 단계가 그것으로 바뀝니다. 이미지는 **나머지 API와 같은 토큰 뒤에서** 제공됩니다
(자기 콘솔 스크린샷에는 구석에 계정 이름이 찍히니까요). `<img src>`는 Authorization 헤더를
보낼 수 없으므로 fetch해서 blob으로 표시합니다.

**키는 당신의 컴퓨터를 떠나지 않습니다.** 호스팅되는 구성 요소가 없습니다. 키가 가는 곳은
두 군데뿐입니다: 당신 볼륨 안의 `600` 파일과, 그 키의 발급처. **저장된 키를 돌려주는
엔드포인트는 없고**(`/v1/providers`는 키가 있는지 여부만 알려줍니다) **로그에도 남지
않습니다.** 이것은 주장이 아니라 테스트로 강제됩니다.

`inferencemesh setup`은 터미널에서 같은 일을 합니다. 각 제공자가 무엇을 주는지 말하고,
키를 받을 페이지를 알려주고, **저장하기 전에 실제 요청으로 키를 검증합니다.**
"저장했습니다"는 안심의 근거가 못 됩니다 — 잘못 입력한 키도 똑같이 잘 저장되니까요.

### "무료"의 진짜 대가

무료는 거래이고, 그 조건은 좀처럼 명시되지 않습니다. `setup`은 무엇을 묻기 전에 이것을 먼저
보여줍니다.

- **당신의 프롬프트가 제공자의 모델 학습에 쓰일 수 있습니다.** 개인정보·의료정보·타인의
  정보는 보내지 마세요
- **키를 브라우저나 모바일 앱에 넣지 마세요.** 서버 뒤에 두세요. 이 게이트웨이가 그 서버입니다
- **가동 보장은 없습니다.** 무료 한도는 예고 없이 사라집니다
- **생각을 그대로 출력하는 모델이 있습니다**("The user asks…"). 당신 코드의 버그가 아닙니다
- **이 게이트웨이는 유료 모델로 몰래 넘어가지 않습니다.** 무료 한도가 소진되면 오류를
  반환합니다. 실수가 청구서로 바뀌지 않습니다

## 설치

실행 파일 하나. Node도 패키지 매니저도 필요 없습니다:

```sh
curl -fsSL https://raw.githubusercontent.com/gdalabs/inferencemesh/main/install.sh | sh
```

플랫폼에 맞는 빌드를 내려받고, **공개된 `SHA256SUMS`와 대조하며, 대조할 수 없으면 설치를
거부합니다** — 바이너리를 바꿔치기할 수 있는 상대라면 검증도 끌 수 있으므로, 끌 수 있는
검증은 검증이 아닙니다. 설치 위치는 `~/.local/bin`. `INFERENCEMESH_BIN_DIR`로 바꿀 수 있고,
`INFERENCEMESH_RELEASE_BASE`는 미러나 오프라인 사본을 가리킬 수 있습니다.
`INFERENCEMESH_SKIP_CHECKSUM=1`로 검증을 건너뛸 수 있지만, 건너뛸 이유가 있어야 합니다.

라이브러리로 쓰거나 소스에서 실행하려면:

```sh
npm install inferencemesh
```

Node 20 이상. 감사할 런타임 의존성이 없습니다 — 컨테이너 이미지에는 컴파일된 결과물만
들어 있습니다.

## 라이브러리로 쓰기

```ts
import { InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from './providers.default.json' with { type: 'json' };

const mesh = new InferenceMesh({ registry: registryFrom(registryFile) });

const res = await mesh.chat({
  model: 'mesh/free',
  messages: [{ role: 'user', content: '한국어로 답해줘' }],
  mesh: { language: 'ko', privacy: 'public' },
});

console.log(res.choices[0].message.content);
console.log(res.mesh);
// { served_by: 'gemini/gemini-2.5-flash', profile: 'free',
//   attempts: [{ key: 'groq/llama-3.3-70b-versatile', status: 429, ... }],
//   latency_ms: 812, cost_usd: 0 }
```

`res.mesh.attempts`에는 도중에 시도하고 실패한 것이 전부 남습니다. **숨기지 않습니다** —
어떤 제공자가 429를 반환해 조용히 다른 곳으로 넘어갔다면, 그렇게 적혀 있습니다.

## 게이트웨이로 쓰기

```sh
export GROQ_API_KEY=...            # 제공자 최소 하나
export INFERENCEMESH_TOKENS=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npx inferencemesh serve
```

그다음 아무 OpenAI 클라이언트나 여기로 향하게 하면 됩니다 — 2026-08-22에 **공식 `openai`
패키지로 실측**했으며 주장이 아닙니다: `models.list()`, usage가 붙은 completion,
스트리밍, 그리고 오타 난 프로필이 재시도 대상이 아니라 **`BadRequestError`(400)** 로
도착하는 것까지.

| 라우트 | 용도 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 호환. 스트리밍 있음/없음 모두 |
| `GET /v1/models` | mesh 프로필과 구체적인 `provider/model` 목록 |
| `GET /healthz` | 차단기 상태, 할당량, 로딩 시 경고 |

서버는 **인증 토큰이 없으면 시작을 거부**하고 **`0.0.0.0` 바인드도 거부**합니다(덮어쓰지
않는 한). 이 프로세스는 당신이 가진 모든 제공자 키를 쥐고 있습니다. 공유 네트워크에 열린
LLM 중계기는 남이 당신의 무료 한도로 추론하는 장치입니다. 앞에 `tailscale serve`나 리버스
프록시를 두세요.

### Cloudflare Workers에서

`handleRequest`는 순수한 Fetch 핸들러라, Worker는 이게 전부입니다. 실물은
[`examples/worker.ts`](examples/worker.ts)이고 **빌드가 컴파일합니다** — README 안에만
있는 스니펫은 아무도 한 번도 돌려보지 않은 스니펫입니다.

```ts
import { handleRequest, InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from './providers.json';

/**
 * 바인딩. 인덱스 시그니처 덕분에 env를 통째로 레지스트리에 넘길 수 있습니다
 * (제공자마다 필요한 변수 이름을 스스로 밝히므로 하나씩 나열할 필요가 없습니다).
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

할당량을 isolate 교체에도 살아남게 하려면 KV나 Durable Object로 `LedgerStorage`를 구현하세요.
기본 인메모리 구현은 isolate와 함께 사라지므로 하루 상한 대비 과소 집계합니다.

---

## 모델 지정 방법

| `model` | 의미 |
|---|---|
| `mesh/free` | 이 프로필 안에서 라우팅 |
| `mesh/best` `mesh/cheap` `mesh/fast` `mesh/coding` `mesh/vision` `mesh/private` | 내장 프로필 |
| `groq/llama-3.3-70b-versatile` | 후보 하나로 고정(pin) |

pin은 프로필의 **가격** 선호를 덮어쓰지만 **기밀성·기능·컨텍스트 필터는 덮어쓰지 않습니다** —
pin으로 기밀 텍스트를 public 등급 제공자에 밀어 넣을 수는 없습니다.

요청 단위 지정은 `mesh` 객체에 넣습니다. 제공자에 닿기 전에 제거됩니다:

```json
{
  "model": "mesh/best",
  "messages": [],
  "mesh": {
    "language": "ko",
    "privacy": "confidential",
    "capabilities": ["vision"],
    "minContext": 100000
  }
}
```

## 후보는 어떻게 선택되나

**하드 필터**(정확성의 문제. 걸러진 후보는 점수와 무관하게 제외):
기밀성 등급 · 필요한 기능 · 컨텍스트 길이 · 프로필의 가격 상한.

**가중 점수**(선호의 문제. 프로필마다 가중치가 다름):
`quality` · `cost` · 관측된 `latency` · `language` 적성.

**그다음 순서대로**: 차단기가 열린 후보를 떨어뜨리고(단 그래서 후보가 비게 된다면 무시합니다 —
아마 죽었을 제공자가 제공자 없는 것보다는 낫습니다), 시도 시점에 할당량을 확인하고, 남은
순위가 폴백 체인이 됩니다.

`inferencemesh route best --language=ko`는 **네트워크를 전혀 건드리지 않고** 판단 전체를
출력합니다. 탈락한 후보에 대해서는 왜 탈락했는지도 나옵니다. 요청에 실을 수 있는 필터는
그대로 플래그이므로, 아무것도 연결하기 전에 라우팅 질문에 답할 수 있습니다:

```sh
inferencemesh route best --language=ko
inferencemesh route free --capabilities=vision,tools   # 선호가 아니라 필수 요건
inferencemesh route best --privacy=confidential        # 후보가 만족해야 할 하한
inferencemesh route free --min-context=200000
```

존재하지 않는 기능·기밀 등급·숫자를 넘기면 **이름을 짚어 거부합니다.** 조용히 전부
걸러내지 않습니다 — 오타는 "빈 레지스트리"가 아니라 "오타"로 읽혀야 합니다.

### 재시도하지 **않는** 것

`400`과 `422`는 요청 쪽 잘못이라 어느 제공자에서도 똑같이 실패합니다. 그래서 체인은 즉시
멈춥니다. `401`은 **재시도합니다** — 다음 제공자는 그 잘못된 키를 공유하지 않으니까요.

### 동시에 몇 개까지

레이트 리밋에는 두 가지 형태가 있고 **윈도인 것은 한쪽뿐**입니다. `quota`는 분당·일당 요청
수를 셉니다. `maxConcurrent`는 **지금 일어나고 있는** 수를 셉니다. 한 번에 하나만 처리하는
제공자는 분당 예산이 거의 손대지 않은 상태에서 팬아웃을 429로 막습니다. 윈도만 세어서는
이것이 보이지 않습니다.

```jsonc
{ "id": "some-provider", "maxConcurrent": 2, "models": [ /* ... */ ] }
```

범위는 모델이 아니라 **제공자**입니다. 상한은 자격 증명에 속하므로, 한 키 뒤에 모델이 둘이면
그 둘이 계정의 슬롯을 나눠 씁니다.

`quota`도 같은 자리에 둘 수 있고, 이유도 같습니다. "분당 10요청"이라고 적힌 무료 티어는
거의 언제나 모델이 아니라 **키**에 대한 제한입니다. 그 숫자를 모델 셋에 적으면 서른을
허용하게 되고, 뒤따르는 429는 다른 실패와 구분되지 않으므로 메시는 조용히 다음 제공자로
넘어가고 잘못된 설정은 끝내 드러나지 않습니다. 제공자에 한 번 적으면 모델 자신의 예산보다
먼저 예약되고 함께 환급됩니다.

```jsonc
{ "id": "orcarouter", "quota": { "requestsPerMinute": 10, "requestsPerDay": 50 } }
```

계정의 열을 모델별로 셋씩 나누는 것은 `maxConcurrent`가 거부하는 바로 그 추측입니다.
제공자가 한 번도 말한 적 없는 모델별 상한을 만들어내고, 트래픽이 한쪽으로 쏠리는 순간
실제 용량을 조입니다.

바쁜 제공자는 기다리지 않고 **건너뜁니다** — 비어 있는 곳으로 넘어가라고 체인이 있는
것이니까요. **모든** 후보가 바쁠 때만 FIFO로 최대
`INFERENCEMESH_CONCURRENCY_WAIT_MS`(기본 30000, `0`이면 기다리지 않고 실패)만큼 대기합니다.
제공자가 하나뿐인 경우의 이야기로, 지금 503을 주는 것보다 잠깐 뒤에 답하는 편이 낫기 때문입니다.

`maxConcurrent`를 적지 않으면 무제한입니다. 아무도 측정하지 않은 상한은 추측으로 실제 용량을
조이는 일입니다. 그래서 배포 레지스트리는 **실측한 곳에만** 적혀 있습니다: `llm7`은 **1**입니다.
2026-08-22에 병렬도를 올려가며 두 번째 요청이
`429 Too many concurrent requests for this client`를 반환하는 지점을 찾았고 세 번 재현했습니다.
당신도 같은 방법이나 제공자 문서에서 찾으세요 — 그리고 **날짜를 옆에 적으세요.**

## 설정

설정은 전부 환경 변수입니다. 서버는 자체 설정 파일을 읽지 않습니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `INFERENCEMESH_TOKENS` | *(없음)* | 쉼표로 구분한 Bearer 토큰. **하나도 없으면 서버는 시작을 거부합니다** — 인증 없는 LLM 중계기는 남이 당신의 무료 추론을 쓰는 장치입니다 |
| `INFERENCEMESH_PORT` | `8910` | 수신 포트 |
| `INFERENCEMESH_HOST` | `127.0.0.1` | 바인드 대상. `0.0.0.0`으로 하려면 `INFERENCEMESH_ALLOW_ANY_HOST=1`도 필요합니다. 이 프로세스가 당신의 모든 제공자 키를 쥐고 있으니까요 |
| `INFERENCEMESH_ALLOW_ANY_HOST` | 미설정 | 루프백 외 바인드를 허용. 컨테이너 안(네트워크 네임스페이스가 경계)에서는 설정합니다. 그 밖의 곳에서는 한 번 더 생각하세요 |
| `INFERENCEMESH_ALLOWED_ORIGINS` | *(없음)* | 브라우저에서 직접 호출할 수 있는 오리진(쉼표 구분). 비면 CORS 헤더를 전혀 내보내지 않습니다 |
| `INFERENCEMESH_PUBLIC_HEALTH` | 미설정 | `1`이면 `/healthz`를 토큰 없이 공개. 제공자 ID·차단기 상태·할당량이 나옵니다. 가동 확인에는 유용하지만 아무에게나 줄 정보도 아닙니다 |
| `INFERENCEMESH_REGISTRY` | *(자동 탐색)* | 레지스트리 파일 경로. **존재하지 않는 경로를 지정하면 오류입니다.** 내장 레지스트리로 조용히 넘어가지 않습니다 |
| `INFERENCEMESH_KEYS` | `.inferencemesh/keys.env` | 설정 화면에서 추가한 키의 저장 위치. 권한 600 |
| `INFERENCEMESH_SHOTS` | `.inferencemesh/shots` | 설정 안내용 스크린샷 디렉터리. `<provider>-<n>.png`. 없어도 됩니다(그림이 그려집니다) |
| `INFERENCEMESH_LEDGER` | `.inferencemesh/ledger.json` | 할당량 카운터. **볼륨에 두세요.** 아니면 재시작할 때마다 그날 쓴 양을 잊습니다 |
| `INFERENCEMESH_CONCURRENCY_WAIT_MS` | `30000` | *모든* 후보가 바쁠 때 대기하는 시간. `0`이면 기다리지 않고 실패 |
| `INFERENCEMESH_LANG` | *(로케일)* | 설정 마법사의 언어(`ja` / `en`). 기본값은 시스템 로케일 |

제공자 키는 각 항목의 `apiKeyEnv`가 밝히는 변수입니다(`GROQ_API_KEY`, `OPENROUTER_API_KEY`
등). 키가 없는 제공자는 건너뛰고 `/healthz`에 이름이 나옵니다.

## 레지스트리 생성하기

손으로 쓴 레지스트리는 주 단위로 움직이는 시장의 스냅숏입니다. 손으로 쓴 가격은 이미 지나간
날에 대한 주장입니다. `sync`는 제공자 자신의 카탈로그를 읽어 기계가 알 수 있는 부분만 씁니다.

```sh
inferencemesh sync --provider=redpill    --out=providers.local.json --dry-run
inferencemesh sync --provider=openrouter --out=providers.local.json --dry-run
inferencemesh sync --provider=nous       --out=providers.local.json --dry-run
```

OpenRouter와 Nous Portal의 카탈로그는 **키가 필요 없습니다.** 누구의 크레딧도 쓰지 않고
갱신할 수 있는 두 경로입니다. 둘 다 무료 한도만 읽습니다(OpenRouter는 2026-08-22 기준
421개 중 22개가 가격 0, Nous는 2026-08-28 기준 371개 중 5개가 모든 층에서 0).

"무료"란 **공개된 가격이 전부 0**이라는 뜻이지 토큰 단가만이 아닙니다. pricing에는
`web_search`·`image`·캐시 관련 키, 그리고 정말로 사람을 걸려 넘어지게 하는 `overrides` —
시간대별 가격 창 — 도 들어 있습니다. 토큰 단가가 0이면서 06:00~24:00 UTC에는 과금하는
모델은 무료가 아니라 **무료처럼 보이는 것**입니다. 2026-08-28 이것은 더 이상 가정이
아니게 되었습니다. `tencent/hy3:free`가 최상위에서는 0을 내걸고 두 개의 창으로 하루를
모두 덮은 채 나타났습니다.

### 익명 프리뷰는 레지스트리에 넣을 것이 아니다

OpenRouter의 `stealth/` 네임스페이스는 **누구 것인지 말하지 않고 미공개 모델을 내보내는**
방식입니다. 2025년 4월 이후 14건 — GPT-4.1, GPT-5, Grok 4 Fast, Xiaomi의 MiMo, Meituan의
LongCat이 여기를 거쳤습니다 — 중앙값 4~12일 동안 돌아간 뒤 **ID가 사라지고 제품명으로 다시
등장합니다.** 무료이면서도 확실히 썩습니다. 그래서 `sync`는 `providers.default.json`에
**쓰는 것 자체를 거부**하고, 매 실행 경고에서 이름을 짚고, `maxPrivacy: "public"`으로
생성합니다(운영자가 익명이고 프롬프트를 보관하므로).

여기서 날짜 필드는 도움이 되지 않습니다. 2026-08-25 시점에 `stealth/ox-alpha`는
`expiration_date: 2098-12-31` — **"종료 예정 없음"을 뜻하는 센티널** — 을 달고 있었습니다.
형식 자체가 2주면 끝나는 등재인데도요. **우리가 가진 유일한 기계 판독 경고가, 가장 확실히
사라질 항목에 대해 "끝나지 않는다"고 말한 것입니다.** 날짜를 믿지 않고 전용 플래그를 둔
이유입니다.

`sync`가 새로 만드는 제공자 항목은 `maxPrivacy: "public"`(최하위)으로 나오고 그 사실을
알립니다. `internal`을 생성하는 것은 그 제공자에 무엇을 맡겨도 되는지를 sync가 정하는
일입니다 — 기존 항목에 대해서는 절대 하지 않는 판단을 신규에 대해서는 조용히 하는 셈이니까요.

쓰지 않는 것: `quality`와 `languages`. 카탈로그는 모델이 좋은지도, 한국어로 대화가 되는지도
모릅니다. 그럴듯한 추측을 거기에 적으면 `best` 프로필의 순서가 조용히 뒤집히고 비영어권
이용자 전부에게 나쁜 결과를 돌려줍니다 — 검증하지 않은 가격과 같은 실패이면서, 청구서라는
알아챌 수단조차 없습니다. 새 항목은 **평가되지 않은** 채로 나오고, 평가하기 전까지 중립적으로
점수가 매겨집니다.

역시 쓰지 않는 것: 기존 항목의 `maxPrivacy`. 카탈로그와 비교해서는 "사람이 올린 것"인지
"제공자가 내린 것"인지 구별할 수 없고, 이 둘은 정반대의 대응이 필요합니다. 카탈로그가
뒷받침하는 등급은 `evidencePrivacy`에 따로 기록되어 **카탈로그 자신의 이전 답과** 비교됩니다.
파일이 카탈로그보다 넓은 등급을 허용하고 있으면 `sync`는 0이 아닌 코드로 끝납니다 — 등급을
낮추거나 `privacyVerifiedAt`을 기록할 때까지. 그리고 **카탈로그 쪽 답이 바뀌는 순간 다시
울립니다.** 예전 승인이 의미를 잃는 시점이 바로 그때이기 때문입니다.

카탈로그에서 사라진 모델은 **삭제가 아니라 비활성화**됩니다. 삭제하면 당신의 평가가 사라지고,
다음 비교에서 "사라졌다는 사실" 자체가 보이지 않게 됩니다.

### 유일하게 미리 오는 경고

부패는 보통 사후에 드러납니다 — 응답을 기다리는 이용자에 의해서. `expiration_date`만이
예외로, 제공자가 "이 무료 한도는 이 날 끝난다"고 기계 판독 가능한 형태로 선언한 것입니다.
`sync`는 이를 `expiresAt`으로 기록하고 60일 이내면 경고합니다. 이 글을 쓸 당시 nvidia의
`:free` 중 셋이 이틀 뒤 만료 예정이었습니다.

`probe`와 `route`도 같은 것을 표시합니다. sync 리포트는 "레지스트리를 다시 만들 때"만 읽히는데,
그때는 "월요일에 사라질 모델로 라우팅하고 있다"는 사실을 알고 싶은 순간이 아니니까요.

라우팅에는 전혀 쓰지 않습니다. 날짜는 의사 표명이지 관측이 아니며, 선언한 기한을 넘겨 살아남은
모델은 JSON 파일 속 계산으로 떨어질 게 아니라 계속 돌아야 합니다.

### 카탈로그가 알 수 없는 것

**"적혀 있지 않음"은 "부정"이 아닙니다.** RedPill에는 기능을 하나도 선언하지 않은 모델이
14개 있고 그중 6개는 TEE에서 돌며, 최소한 하나는 도구 호출을 문제없이 해냅니다. sync는 그런
모델에 `text`만 기록하고 경고합니다. **아무도 주장한 적 없는 "도구 미지원"을 쓰지 않고**,
당신이 실측해 적어 둔 기능을 덮어쓰지도 않습니다.

이 마지막 대목은 들리는 것보다 좁은 이야기라 정확히 말할 가치가 있습니다: 카탈로그가 소유하는
것은 **실제로 표현할 수 있는 기능뿐** — `text` `vision` `tools` `json` — 그 이상이 아닙니다.
**`code`를 기술할 수 있는 카탈로그는 없습니다.** 기능 목록을 통째로 덮어쓰면 아무것도 변하지
않은 모델에서 손으로 적은 `code`가 사라지고 `mesh/coding`이 그 모델을 놓칩니다. 카탈로그는
관측한 만큼만 갱신하고, 보지 못하는 것을 지울 권한은 없습니다.

`is_tee: true`는 `internal`은 되지만 `confidential`은 되지 않습니다. 그것은 제공자가 JSON
필드에서 자기 자신에 대해 주장하는 것일 뿐, 아무도 어테스테이션을 검증하지 않았습니다. 게다가
RedPill에서는 TEE 운영자가 짐작한 회사가 아닌 경우가 잦습니다 — `providers` 목록에는
`chutes` `near-ai` `tinfoil` `secretai`도 함께 있고, 여러 개가 적힌 모델에서는 호출하는
쪽에 고를 방법이 없습니다.

## 레지스트리를 정직하게 유지하기

`providers.default.json`이 배포하는 것은 **무료 한도만, 가격 0만**입니다 — 제공자에 대한
숫자 중 **거짓이 되는 방식으로 낡을 수 없는 유일한 수**이기 때문입니다. 유료 모델은 의도적으로
배포하지 않습니다. 가격은 예고 없이 바뀌고, 낡은 가격은 크게 실패하지 않고 `cheap` 프로필의
순서를 조용히 바꿉니다. `providers.example.json`을 복사해 **직접 검증한 가격**을 적으세요.

모델 ID와 무료 한도는 **조용히 썩습니다.** 첫 증상은 응답을 기다리는 이용자입니다. 그것을
종료 코드로 바꾸세요:

```sh
inferencemesh version          # 어떤 빌드인지
inferencemesh probe            # 모든 후보를 한 번씩 호출
inferencemesh probe --json     # 스케줄러용. `ending`도 함께
```

`probe`는 비슷해 보이지만 다른 두 가지를 구분합니다: `404`/`400`은 "ID가 사라졌다"이고 사람의
손이 필요합니다(`BROKE`, 종료 코드 1). `429`는 "무료 한도가 설계대로 동작하고 있다"입니다
(`limit`, 종료 코드 0). 후자로 매일 밤 알림을 울리는 것은 감시를 무시하는 습관을 사람에게
가르치는 방법입니다.

`quality`와 `languages`는 손으로 관리하는 **상대적 추정치**이지 벤치마크 결과가 아닙니다.
**당신의** 레지스트리 순서만 맞으면 됩니다. 다만 `languages` 쪽은 최소한 **증거로 반박할 수
있습니다**:

```sh
inferencemesh probe --language=ko          # 한국어로 묻고, 돌아온 답을 채점
inferencemesh probe --language=ko --json
```

판정할 수 있는 것은 문자 체계만으로 언어가 정해지는 것들 — 일본어(가나를 보므로 중국어가
일본어로 통과하지 않습니다), 중국어, 한국어, 러시아어, 아랍어, 힌디어, 태국어, 히브리어,
그리스어, 아르메니아어, 조지아어, 벵골어, 타밀어 — 에 더해 기능어로 구별하는 라틴 문자권
11개 언어입니다. 그 밖은 실패가 아니라 `unjudged`(판정 불가)로 보고합니다.

문자 체계를 공유하는 언어에 대해서는 **구별하는 글자**도 봅니다: 우크라이나어 답변은 러시아어
주장을 뒷받침하지 않고, 페르시아어는 아랍어로 통과하지 않습니다. `zh-Hant`에 간체자로 답할
수도 없습니다 — 반면 `zh` 단독은 둘 다 받아들입니다. 어느 쪽도 요구하지 않았으니까요. 이
검사는 **부정에만 쓸 수 있습니다.** 구별할 재료가 없는 답변은 문자 체계 판정 그대로 두고,
두 언어의 고유 글자가 동시에 나온 답변은 "발견"이 아니라 "증거 없음"으로 취급합니다. 구별할
글자가 존재하지 않는 짝(힌디어와 마라티어)은 지금도 구별하지 못합니다.

각 후보에게는 **그 언어로 쓰인** 질문 두 개를 던집니다 — 영어로 "한국어로 답하라"고 지시하는
것은 언어가 아니라 지시 수행을 측정하는 일이므로 — 그리고 답변을 문자 체계와 기능어로
채점합니다. 결과는 레지스트리의 주장과 나란히 출력되고, **FAULT가 되는 것은 한 방향뿐**입니다:
레지스트리가 "지원한다"고 말했는데 모델이 그 언어로 답하지 않는 경우(종료 코드 1). 낮게
평가되었는데 잘 답하는 모델은 `understated`로 보고됩니다. 읽을 가치는 있지만 누구를 깨울
일은 아닙니다.

모든 후보가 도달 불가이거나 레이트 리밋이었던 실행은 `no contradictions`(모순 없음)가 아니라
**`nothing was measured`(아무것도 측정하지 않음)** 로 보고합니다. `--json`은 `ok` 옆에
`judged` 개수를 함께 담습니다. **측정 0회에서의 `ok: true`는 가장 오해를 부르는 초록불**이니까요.

**점수는 절대 쓰지 않습니다.** 한국어로 답한 것은 compliance(요구를 따랐는가)이지
competence(얼마나 잘하는가)가 아니며, 합격을 `0.84`로 바꾸는 것은 **측정값이 들어가야 할
자리에 지어낸 숫자를 놓는 일**입니다 — 검증하지 않은 가격과 같은 실패입니다. 판정할 수 없는
것은 판정할 수 없다고 말합니다: 판정기가 없는 언어, 이웃 언어와 구별하기에 너무 짧은 답변,
토큰 상한 때문에 생각 도중에 잘린 답변 — 모두 실패가 아니라 `unjudged`로 돌아옵니다. 마지막
것은 가정이 아닙니다. 이 명령의 첫 실행은 **어떤 모델이 영어로 "한국어로 답하자"고 추론하는
도중에, 그 언어의 실패라고 판정했습니다.**

## 새 제공자 찾기

신규 진입자는 의도적으로 추론을 나눠 줍니다 — 자선이 아니라 고객 획득입니다 — 그래서 오늘
가장 좋은 무료 한도는 당신이 레지스트리를 쓸 때는 없던 것인 경우가 많습니다. 손으로 쓴 목록은
배포한 그 달에 낡습니다.

```sh
node scripts/discover-providers.mjs        # 새로운 것이 있으면 종료 코드 10
node scripts/discover-providers.mjs --json
```

각 제공자 자신의 `/v1/models`를 지난번 실행과 비교하고(추가뿐 아니라 **당신의 레지스트리를
망가뜨리는 쪽인 삭제**도 잡습니다), Hacker News와 별이 많은 커뮤니티 목록도 훑습니다. 모든
정보원은 키가 필요 없습니다. 키가 필요한 정보원은 **당신이 보지 않게 된 바로 그때** 동작을
멈추기 때문입니다. 발견된 것은 후보입니다. 추가하기 전에 `probe`로 확인하세요.

## 키가 아예 필요 없는 제공자

제공자는 `apiKeyOptional: true`를 선언할 수 있습니다. 그러면 자격 증명 없이도 로드되고
어댑터는 `Authorization` 헤더를 **보내지 않습니다** — 빈 `Bearer `를 잘못된 형식으로 거부하는
게이트웨이가 있고, 그것은 잘못된 키와 구별되지 않기 때문입니다.

덕분에 가입 없는 배포가 가능합니다. 환경 변수가 비어 있어도 공개 등급 제공자만으로 메시는
라우팅합니다. 배포 레지스트리에서는 그런 제공자를 `maxPrivacy: "public"`으로 고정해 두었고
**그대로 두어야 합니다** — 누구나 익명으로 호출할 수 있는 엔드포인트는, 로그에 남으면 곤란한
것을 보낼 곳이 아닙니다.

## 개발

```sh
npm test        # 빌드한 뒤 스위트를 실행(네트워크 불필요, 키 불필요)
npm run build
```

스위트의 실패 경로는 **일부러 망가뜨린 입력**으로 하나씩 돌려 두었습니다 — 망가진 레지스트리,
빈 토큰 집합, JSON 중간에서 끊긴 스트림 청크, 만료된 할당량 창 — **한 번도 발화한 적 없는
검사는 동작한다고 알려진 검사가 아니기** 때문입니다.

## 라이선스

MIT © GDA Labs
