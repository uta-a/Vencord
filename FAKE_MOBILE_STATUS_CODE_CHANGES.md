# FakeMobileStatus のコード変更内容

この文書は、公式 Vencord に対して `moded` 側で変更した以下2ファイルの内容をまとめたもの。

- `src/preload.ts`
- `src/webpack/patchWebpack.ts`

目的は、Discord Desktop から接続していても、Discord Gateway に送られる IDENTIFY 情報を Android / Discord Android 風に見せること。

## `src/preload.ts`

### 追加した関数

`installFakeMobileStatusFastConnectBlock()` を追加した。

この関数は Discord Desktop の preload 処理中に、ページ側の `globalThis.WebSocket` を `Proxy` で差し替える。

対象になる WebSocket は以下の条件をすべて満たすもの。

1. URL が文字列
2. `gateway.discord.gg` を含む
3. `encoding=etf` を含む
4. `compress=zstd-stream` を含む
5. まだ一度もブロックしていない

条件に一致した場合、接続先 URL を次のように差し替える。

```text
ws://127.0.0.1:9
```

具体例として、Discord が起動直後に以下のような fast-connect Gateway 接続を作ろうとした場合、

```text
wss://gateway.discord.gg/?encoding=etf&compress=zstd-stream...
```

その接続先を `ws://127.0.0.1:9` に置き換えて、一度だけ失敗させる。

### 追加した呼び出し

Discord Desktop 用の preload 処理内で、renderer JS を注入する前に以下を呼ぶようにした。

```ts
installFakeMobileStatusFastConnectBlock();
```

変更後の順番は概念的に以下。

```ts
if (IS_DISCORD_DESKTOP) {
    installFakeMobileStatusFastConnectBlock();
    webFrame.executeJavaScript(sendSync<string>(IpcEvents.PRELOAD_GET_RENDERER_JS));
    require(process.env.DISCORD_PRELOAD!);
}
```

renderer JS より前に入れている理由は、Discord の fast-connect WebSocket が早い段階で作られるため。後から hook しても初回接続に間に合わない可能性がある。

### 二重適用防止

`Symbol.for("FakeMobileStatus.fastConnectBlock")` を marker として使い、同じ hook が複数回入らないようにしている。

```js
const marker = Symbol.for("FakeMobileStatus.fastConnectBlock");
if (globalThis[marker]) return;
globalThis[marker] = true;
```

### ログ

ブロックした場合は console に以下を出す。

```text
[FakeMobileStatus] Blocking Discord fast connect WebSocket
```

## `src/webpack/patchWebpack.ts`

このファイルでは、主に2種類の変更を加えた。

1. `WebSocket.prototype.send` を hook して IDENTIFY payload を差し替える
2. Webpack module factory 内の `_doIdentify()` 実装を早期に書き換える

## 変更1: IDENTIFY 送信時の WebSocket hook

### 追加した定数

二重適用防止用に以下を追加した。

```ts
const fakeMobileStatusGatewaySendPatch = Symbol.for("FakeMobileStatus.gatewaySendPatch");
```

`WebSocket.prototype` にこの symbol を付けて、すでに patch 済みなら再適用しない。

### 追加した properties 生成関数

`getFakeMobileStatusProperties()` を追加した。

この関数は、Gateway IDENTIFY の `d.properties` に入れる Android 風の固定値を返す。

```json
{
  "os": "Android",
  "browser": "Discord Android",
  "device": "Discord Android",
  "browser_user_agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "browser_version": "125.0.0.0",
  "os_version": "14"
}
```

### 追加した hook 関数

`installFakeMobileStatusGatewaySendPatch()` を追加した。

この関数は `WebSocket.prototype.send` を差し替え、送信データが Discord Gateway の IDENTIFY payload らしい場合だけ中身を書き換える。

判定条件は以下。

1. `data` が文字列
2. 文字列に `"op":2` が含まれる
3. JSON として parse できる
4. `payload.op === 2`
5. `payload.d.properties` が存在する

条件に一致した場合、以下のように `payload.d.properties` を Android 風の値に置き換える。

```ts
payload.d = {
    ...payload.d,
    properties: getFakeMobileStatusProperties()
};
```

例えば変更前の `properties` が以下だった場合、

```json
{
  "os": "Windows",
  "browser": "Discord Client",
  "device": ""
}
```

送信直前に以下へ置き換わる。

```json
{
  "os": "Android",
  "browser": "Discord Android",
  "device": "Discord Android",
  "browser_user_agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "browser_version": "125.0.0.0",
  "os_version": "14"
}
```

その後、変更済み payload を `JSON.stringify(payload)` して、本来の `send` に渡す。

### parse 失敗時の挙動

JSON parse に失敗した場合は何も変更せず、元の `send` を呼ぶ。

```ts
} catch { }
```

これは、IDENTIFY 以外の通常 WebSocket 通信を壊さないため。

### ログ

IDENTIFY properties を書き換えた場合は console に以下を出す。

```text
[FakeMobileStatus] Gateway IDENTIFY properties
```

## 変更2: Webpack module factory の早期 patch

### 追加した処理

`patchFactory()` 内で、通常の Vencord plugin patch を回す前に、Discord の GatewaySocket `_doIdentify()` らしい module factory を直接書き換える処理を追加した。

追加場所は、概念的には以下の直後。

```ts
let patchedSource = code;
let patchedFactory = originalFactory;
```

### 検出条件

対象 module factory は以下で検出する。

1. factory source に `_doIdentify(){` が含まれる
2. factory source に `GatewaySocket` が含まれる
3. `properties:` の後ろにある変数名を正規表現で取得できる

正規表現は2段構え。

```ts
const fakeMobileStatusPrimaryMatch = /(?<="GatewaySocket"\)\}\),properties:)([A-Za-z_$][\w$]*)/;
const fakeMobileStatusFallbackMatch = /(?<=properties:)([A-Za-z_$][\w$]*)(?=,presence:)/;
```

primary が一致すれば primary を使い、一致しなければ fallback を使う。

### 書き換え内容

`properties:` に渡される元の変数を使わず、Android 風の固定オブジェクトに置き換える。

```js
{
  os: "Android",
  browser: "Discord Android",
  device: "Discord Android",
  browser_user_agent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  browser_version: "125.0.0.0",
  os_version: "14"
}
```

その後、書き換え済みの factory source を `eval` して `patchedFactory` に入れる。

```ts
patchedFactory = (0, eval)(patchedSource);
```

### 早期 patch を入れている理由

通常の plugin patch や `WebSocket.prototype.send` hook だけでは、Discord の初回 IDENTIFY に間に合わない可能性がある。

そのため、Webpack module factory を読み込む段階で `_doIdentify()` の中身を直接変え、初回 IDENTIFY でも Android 風 properties が使われるようにしている。

## 変更による効果

この2ファイルの変更により、以下の3段階で FakeMobileStatus の目的を達成しようとしている。

1. `src/preload.ts` で fast-connect Gateway 接続を一度失敗させる
2. `src/webpack/patchWebpack.ts` の早期 patch で `_doIdentify()` の `properties` を Android 風にする
3. `src/webpack/patchWebpack.ts` の WebSocket hook で、送信直前の IDENTIFY payload も Android 風にする

つまり、Discord 側の接続経路やタイミングが変わっても、複数の経路で `d.properties` を差し替える構成になっている。

## 注意点

`src/preload.ts` の変更は `globalThis.WebSocket` を差し替えるため、対象外の WebSocket も Proxy 経由になる。ただし、URL 条件に一致しない通信はそのまま通す。

`src/webpack/patchWebpack.ts` の早期 patch は、Discord の minify 済みコードの形に依存している。`_doIdentify(){`、`GatewaySocket`、`properties:` 周辺が変わると当たらなくなる可能性がある。

また、この変更は Discord クライアントの識別情報を偽装するため、Discord の利用規約や運用ポリシー上のリスクになり得る。
