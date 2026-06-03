import { readFileSync, writeFileSync } from "node:fs";

const fakeMobileProperties = `{os:"Android",browser:"Discord Android",device:"Discord Android",browser_user_agent:"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",browser_version:"125.0.0.0",os_version:"14"}`;

function read(path) {
    return readFileSync(path, "utf8");
}

function write(path, source) {
    writeFileSync(path, source);
}

function replaceOnce(source, search, replacement, description) {
    if (!source.includes(search)) {
        throw new Error(`Could not find anchor for ${description}`);
    }

    return source.replace(search, replacement);
}

function patchPreload() {
    const path = "src/preload.ts";
    let source = read(path);

    if (!source.includes("FakeMobileStatus.fastConnectBlock")) {
        const installFunction = `
function installFakeMobileStatusFastConnectBlock() {
    if (!IS_DISCORD_DESKTOP || location.protocol === "data:") return;

    webFrame.executeJavaScript(\`
        (() => {
            const marker = Symbol.for("FakeMobileStatus.fastConnectBlock");
            if (globalThis[marker]) return;
            globalThis[marker] = true;

            const NativeWebSocket = globalThis.WebSocket;
            if (typeof NativeWebSocket !== "function") return;

            let blocked = false;
            function shouldBlock(url) {
                return !blocked
                    && typeof url === "string"
                    && url.includes("gateway.discord.gg")
                    && url.includes("encoding=etf")
                    && url.includes("compress=zstd-stream");
            }

            globalThis.WebSocket = new Proxy(NativeWebSocket, {
                construct(target, args, newTarget) {
                    if (shouldBlock(args[0])) {
                        blocked = true;
                        console.info("[FakeMobileStatus] Blocking Discord fast connect WebSocket", args[0]);
                        args[0] = "ws://127.0.0.1:9";
                    }

                    return Reflect.construct(target, args, newTarget);
                }
            });
        })();
    \`);
}
`;

        source = replaceOnce(
            source,
            `contextBridge.exposeInMainWorld("VencordNative", VencordNative);\n`,
            `contextBridge.exposeInMainWorld("VencordNative", VencordNative);\n${installFunction}`,
            "FakeMobileStatus preload function"
        );
    }

    if (!source.includes("installFakeMobileStatusFastConnectBlock();")) {
        source = replaceOnce(
            source,
            `    if (IS_DISCORD_DESKTOP) {\n        webFrame.executeJavaScript(sendSync<string>(IpcEvents.PRELOAD_GET_RENDERER_JS));`,
            `    if (IS_DISCORD_DESKTOP) {\n        installFakeMobileStatusFastConnectBlock();\n        webFrame.executeJavaScript(sendSync<string>(IpcEvents.PRELOAD_GET_RENDERER_JS));`,
            "FakeMobileStatus preload call"
        );
    }

    write(path, source);
}

function patchWebpack() {
    const path = "src/webpack/patchWebpack.ts";
    let source = read(path);

    if (!source.includes("FakeMobileStatus.gatewaySendPatch")) {
        const gatewayPatch = `
const fakeMobileStatusGatewaySendPatch = Symbol.for("FakeMobileStatus.gatewaySendPatch");

function getFakeMobileStatusProperties() {
    return {
        os: "Android",
        browser: "Discord Android",
        device: "Discord Android",
        browser_user_agent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
        browser_version: "125.0.0.0",
        os_version: "14"
    };
}

function installFakeMobileStatusGatewaySendPatch() {
    const proto = WebSocket?.prototype as WebSocket["prototype"] & {
        [fakeMobileStatusGatewaySendPatch]?: true;
    };

    if (proto == null || proto[fakeMobileStatusGatewaySendPatch]) return;

    const originalSend = proto.send;
    proto[fakeMobileStatusGatewaySendPatch] = true;
    proto.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string" && data.includes('"op":2')) {
            try {
                const payload = JSON.parse(data);
                if (payload?.op === 2 && payload.d?.properties != null) {
                    payload.d = {
                        ...payload.d,
                        properties: getFakeMobileStatusProperties()
                    };

                    console.info("[FakeMobileStatus] Gateway IDENTIFY properties", payload.d.properties);
                    return originalSend.call(this, JSON.stringify(payload));
                }
            } catch { }
        }

        return originalSend.call(this, data);
    };
}

installFakeMobileStatusGatewaySendPatch();
`;

        source = replaceOnce(
            source,
            `const logger = new Logger("WebpackPatcher", "#8caaee");\n`,
            `const logger = new Logger("WebpackPatcher", "#8caaee");\n${gatewayPatch}`,
            "FakeMobileStatus gateway send patch"
        );
    }

    source = source.replace(
        `if (Settings.plugins.FakeMobileStatus?.enabled && typeof data === "string" && data.includes('"op":2')) {`,
        `if (typeof data === "string" && data.includes('"op":2')) {`
    );

    if (!source.includes("Patched by FakeMobileStatusEarly")) {
        const earlyPatch = `
    const fakeMobileStatusPrimaryMatch = /(?<="GatewaySocket"\\)\\}\\),properties:)([A-Za-z_$][\\w$]*)/;
    const fakeMobileStatusFallbackMatch = /(?<=properties:)([A-Za-z_$][\\w$]*)(?=,presence:)/;
    const fakeMobileStatusMatch = fakeMobileStatusPrimaryMatch.test(code)
        ? fakeMobileStatusPrimaryMatch
        : fakeMobileStatusFallbackMatch.test(code)
            ? fakeMobileStatusFallbackMatch
            : null;
    if (code.includes("_doIdentify(){") && code.includes("GatewaySocket") && fakeMobileStatusMatch != null) {
        code = code.replace(fakeMobileStatusMatch, '${fakeMobileProperties}');
        patchedSource = \`// Webpack Module \${String(moduleId)} - Patched by FakeMobileStatusEarly
\${code}
//# sourceURL=file:///WebpackModule\${String(moduleId)}\`;
        patchedFactory = (0, eval)(patchedSource);
    }
`;

        source = replaceOnce(
            source,
            `    let patchedSource = code;\n    let patchedFactory = originalFactory;\n`,
            `    let patchedSource = code;\n    let patchedFactory = originalFactory;\n${earlyPatch}`,
            "FakeMobileStatus early identify patch"
        );
    }

    source = source.replace(/\{\.\.\.[A-Za-z_$][\w$]*,os:"Android",browser:"Discord Android",device:"Discord Android",browser_user_agent:"Mozilla\/5\.0 \(Linux; Android 14\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/125\.0\.0\.0 Mobile Safari\/537\.36",browser_version:"125\.0\.0\.0",os_version:"14"\}/g, fakeMobileProperties);

    write(path, source);
}

patchPreload();
patchWebpack();

console.log("Applied FakeMobileStatus patches.");
