/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState } from "./types.mjs";
export { CallState } from "./types.mjs";
const SHA256_LEN = 32;
const loadBaileys = async () => {
    try {
        return await import("@whiskeysockets/baileys");
    }
    catch {
        throw new Error("Could not import @whiskeysockets/baileys. Install it as a peer dependency.");
    }
};
const toBareJid = (jid) => {
    if (!jid)
        return jid;
    const at = jid.indexOf("@");
    if (at < 0)
        return jid;
    const user = jid.slice(0, at).split(":")[0];
    return `${user}@${jid.slice(at + 1)}`;
};
const computeHkdf = (key, salt, info, length) => {
    const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
    const prk = createHmac("sha256", effectiveSalt).update(key).digest();
    const blocks = Math.ceil(length / SHA256_LEN);
    const okm = Buffer.alloc(blocks * SHA256_LEN);
    let prev = Buffer.alloc(0);
    for (let i = 1; i <= blocks; i += 1) {
        prev = createHmac("sha256", prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest();
        prev.copy(okm, (i - 1) * SHA256_LEN);
    }
    return new Uint8Array(okm.buffer, okm.byteOffset, length);
};
const computeHmacSha256 = (data, key) => {
    const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};
const isCallReceiptNode = (node) => {
    if (node?.tag !== "receipt")
        return false;
    const child = Array.isArray(node.content) ? node.content[0] : null;
    return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};
/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
    callId;
    engine;
    #state = CallState.Idle;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #ended = false;
    /** Why the callee's side ended the call, noted from its stanza before the engine sees it; null until then. */
    #peerEndReason = null;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource = "silence";
    constructor(callId, engine, durationMs) {
        super();
        this.callId = callId;
        this.engine = engine;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
        if (durationMs > 0) {
            this.#endTimer = setTimeout(() => this.end(), durationMs);
        }
    }
    get state() { return this.#state; }
    end = (reason = "hangup") => {
        if (this.#ended)
            return;
        try {
            this.engine.endCall(0, true);
        }
        catch { }
        // `_forceEnd` is what clears the end timer, emits `ended` and resolves
        // `waitForEnd()`; setting `#ended` first would make it a no-op and wedge
        // every `waitForEnd()` caller.
        this._forceEnd(reason);
    };
    mute = (muted) => {
        try {
            this.engine.setMute(muted);
        }
        catch { }
    };
    waitForEnd = () => this.#endPromise;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState = (state) => {
        this.#state = state;
        if (state === CallState.PreacceptReceived)
            this.emit("ringing");
        else if (state === CallState.Active)
            this.emit("connected");
        else if (state === CallState.Idle || state === CallState.Ending) {
            this._forceEnd(this.#peerEndReason ?? "ended");
        }
    };
    /**
     * @internal — the callee's side ended a call that was never answered. WhatsApp tells us with a `reject` (declined)
     * or a `terminate` (`reason="timeout"` when it rang out) stanza, and the engine does not always turn either into a
     * state change, so without this the call would ring until the caller's own timeout. An answered call is left to the engine.
     * Ends through `end()`, not `_forceEnd()`: the engine must leave the call too, or it ignores the next `startCall` and
     * that call never rings.
     */
    _peerEnded = (tag, reason) => {
        if (this.#state === CallState.Active)
            return;
        this.end(peerEndReason(tag, reason));
    };
    /**
     * @internal — notes why the callee's side is ending an unanswered call, before its stanza reaches the engine. The
     * engine may react to that stanza with a state change that ends the call first, and that change alone says only
     * "ended"; with the note it reports `no_answer` / `remote_end` like `_peerEnded` would.
     */
    _notePeerEnd = (tag, reason) => {
        if (this.#state === CallState.Active)
            return;
        this.#peerEndReason ??= peerEndReason(tag, reason);
    };
    /** @internal — engine event 11: the callee declined. */
    _peerRejected = () => {
        this._peerEnded("reject");
    };
    /** @internal */
    _emitAudio = (pcm) => { this.emit("audio", pcm); };
    /** @internal */
    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        this.emit("ended", reason);
        this.#endResolver(reason);
    };
}
/** Disconnects after which reopening is pointless or harmful, by the reason `disconnectReason()` reports. */
const TERMINAL_DISCONNECT_REASONS = new Map([
    [401, "logged_out"], // unlinked from the phone: needs a new QR
    [440, "replaced"], // another session took over these credentials; reopening would fight it
    [403, "forbidden"], // the account is banned
]);
/**
 * Refusals from WhatsApp's side that a reconnect seldom fixes (a corrupt session, a device-list mismatch). Every
 * attempt reaches WhatsApp, and logging in again and again looks like abuse, so they are given up on after
 * `SERVER_REJECT_LIMIT` in a row.
 */
const SERVER_REJECT_REASONS = new Map([
    [500, "bad_session"],
    [411, "multidevice_mismatch"],
]);
const SERVER_REJECT_LIMIT = 3;
/**
 * Pause before each reconnect attempt; the last value repeats until the socket is back. Attempts made while the
 * network is down never reach WhatsApp, so retrying forever is cheap — the long tail just keeps a worker that
 * stays offline for hours from spinning.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 60_000, 120_000, 300_000];
/** `terminate` with `reason="timeout"` means it rang out; anything else (a `reject`, a busy line) is the callee's doing. */
function peerEndReason(tag, reason) {
    return tag === "terminate" && reason === "timeout" ? "no_answer" : "remote_end";
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export class VoipClient {
    #config;
    #engine = null;
    #relay = null;
    #signaling = null;
    #sock = null;
    #activeCall = null;
    #baileys = null;
    #open = false;
    /** Builds a fresh socket over the same auth state; kept so a dropped socket can be replaced without a QR. */
    #createSocket = null;
    /** Set by `disconnect()`: a socket closing after that is expected and must not be reopened. */
    #closing = false;
    #reconnectTimer = null;
    #reconnectAttempt = 0;
    /** Consecutive `SERVER_REJECT_REASONS` closes; any other close resets it. */
    #serverRejects = 0;
    #disconnectReason = null;
    // Capture state populated when WASM negotiates audio params
    #capturePtr = 0;
    #captureChunkBytes = 0;
    #captureSampleRate = 16000;
    #captureChannels = 1;
    #captureFramesPerChunk = 320;
    #feeder = null;
    constructor(config) {
        this.#config = config;
    }
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect = async () => {
        this.#baileys = await loadBaileys();
        const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
        const makeSocket = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;
        const authDir = resolve(this.#config.authDir);
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const silentLogger = {
            level: "silent",
            child: () => silentLogger,
            trace: () => { },
            debug: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            fatal: () => { },
        };
        const createSocket = () => {
            const sock = makeSocket({
                auth: state,
                emitOwnEvents: true,
                logger: silentLogger,
            });
            sock.ev.on("creds.update", saveCreds);
            return sock;
        };
        this.#createSocket = createSocket;
        this.#closing = false;
        // Connect with auto-reconnect on the post-QR 515 stream-error path.
        await new Promise((resolveOpen, rejectOpen) => {
            let opened = false;
            let retries = 0;
            const maxRetries = 5;
            const connectSocket = () => {
                const sock = createSocket();
                this.#sock = sock;
                process.removeAllListeners("uncaughtException");
                process.on("uncaughtException", (err) => {
                    const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
                    if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
                        retries += 1;
                        setTimeout(connectSocket, 1500);
                    }
                    else if (!opened) {
                        rejectOpen(err);
                    }
                });
                sock.ev.on("connection.update", (update) => {
                    // A replaced socket can still report; only the current one counts.
                    if (sock !== this.#sock)
                        return;
                    if (update.qr) {
                        if (this.#config.onQr)
                            this.#config.onQr(update.qr);
                        else
                            void import("qrcode-terminal")
                                .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
                                .catch(() => {
                                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                                console.log(update.qr);
                            });
                    }
                    if (update.connection === "open") {
                        this.#open = true;
                        opened = true;
                        process.removeAllListeners("uncaughtException");
                        resolveOpen();
                        return;
                    }
                    if (update.connection === "close" && opened) {
                        this.#handleSocketClosed(update.lastDisconnect?.error);
                        return;
                    }
                    if (update.connection === "close" && !opened) {
                        this.#open = false;
                        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                        const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
                        if (shouldReconnect && retries < maxRetries) {
                            retries += 1;
                            setTimeout(connectSocket, 1000);
                        }
                        else {
                            rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
                        }
                    }
                });
            };
            connectSocket();
        });
        await this.#bindSocket(this.#sock);
        this.#relay = new RelayRtcTransport({
            onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
            onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
        });
        this.#engine = new WasmEngine({
            callbacks: {
                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),
                onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
                sendDataToRelay: (data, ip, port) => this.#relay.send(data, ip, port),
                onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
                onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
                onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
                onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
                cryptoHkdf: computeHkdf,
                hmacSha256: computeHmacSha256,
            },
        });
        await this.#engine.initialize();
        this.#signaling.attachEngine(this.#engine);
        const selfPnJid = this.#sock.authState.creds.me?.id;
        const selfLidJid = this.#sock.authState.creds.me?.lid;
        this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
        await this.#engine.waitForVoipStackReady();
        try {
            this.#engine.updateNetworkMedium(2, 0);
        }
        catch { }
    };
    /** Place an outbound voice call. */
    call = async (phoneNumber, opts = {}) => {
        if (!this.#engine || !this.#signaling)
            throw new Error("Not connected. Call connect() first.");
        if (this.#activeCall)
            throw new Error("A call is already active.");
        const targetNumber = phoneNumber.replace(/\D/g, "");
        const targetPnJid = `${targetNumber}@s.whatsapp.net`;
        const durationMs = opts.durationMs ?? 120_000;
        const audioSource = opts.audioSource ?? "silence";
        const peerLid = await this.#signaling.resolveLid(targetPnJid);
        if (!peerLid)
            throw new Error(`Could not resolve LID for ${targetPnJid}`);
        for (const jid of [targetPnJid, peerLid]) {
            try {
                await this.#sock.presenceSubscribe(jid);
            }
            catch { }
        }
        await new Promise((r) => setTimeout(r, 750));
        const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
        const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];
        await this.#signaling.ensureSessionsForPeers(deviceList);
        await new Promise((r) => setTimeout(r, 500));
        await this.#signaling.issueTcToken(peerLid);
        const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);
        const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();
        const call = new ActiveCall(callId, this.#engine, durationMs);
        call._audioSource = audioSource;
        this.#activeCall = call;
        this.#engine.startCall({
            peerJid: peerLid,
            peerPn: targetPnJid,
            peerList: deviceList,
            callId,
            isVideo: false,
            isLidCall: true,
            isFromDialer: false,
            extraData: tcToken,
        });
        // A finished call must release the slot: `#activeCall` is otherwise never
        // cleared, so every later `call()` throws "A call is already active."
        call.once("ended", () => {
            if (this.#activeCall === call)
                this.#activeCall = null;
        });
        return call;
    };
    /**
     * Push one 16 kHz mono f32 frame of the local (caller) side into the WhatsApp
     * uplink. Dropped until the WASM starts asking for capture, i.e. until the
     * callee has answered (`AudioFeeder` is created on capture start).
     */
    write = (pcm) => {
        this.#feeder?.write(pcm);
    };
    /** True once the socket is open — a populated `authDir` opens without a QR scan. */
    isOpen = () => this.#open;
    /**
     * Why the socket is down after having been open, or null while it is open (or was never opened):
     * `"reconnecting"` while it is being reopened, or the reason it was given up on — `"logged_out"`, `"replaced"`,
     * `"forbidden"`, `"bad_session"`, `"multidevice_mismatch"`. A given-up socket stays down until `connect()` runs
     * again in a new client (in practice: the service restarts, or the worker is re-linked).
     */
    disconnectReason = () => this.#disconnectReason;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect = () => {
        this.#closing = true;
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        this.#open = false;
        this.#activeCall?._forceEnd("disconnect");
        this.#activeCall = null;
        this.#relay?.closeAll();
        this.#engine?.destroy();
        this.#sock?.end?.();
        this.#engine = null;
        this.#relay = null;
        this.#signaling = null;
        this.#sock = null;
    };
    // ─── private ──────────────────────────────────────────────────────────────
    /**
     * Wires a freshly opened socket: a signaling bridge of its own (the bridge hooks that socket's key store) and the
     * call/receipt listeners on its websocket. The WASM engine and relay transport outlive sockets and are reused.
     */
    #bindSocket = async (sock) => {
        const signaling = new SignalingBridge({ sock });
        await signaling.init();
        if (this.#engine)
            signaling.attachEngine(this.#engine);
        this.#signaling = signaling;
        sock.ws.on("CB:call", (node) => {
            if (!this.#engine || sock !== this.#sock)
                return;
            const child = Array.isArray(node.content) ? node.content[0] : null;
            const callId = child?.attrs?.["call-id"] ?? child?.attrs?.call_id;
            const peerEnd = (child?.tag === "reject" || child?.tag === "terminate") && callId && callId === this.#activeCall?.callId
                ? this.#activeCall
                : null;
            // Noted before the engine sees the stanza: its state change can end the call before we get another chance.
            peerEnd?._notePeerEnd(child.tag, child.attrs.reason);
            this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");
            // When the engine does not end the call on its own, end it here.
            peerEnd?._peerEnded(child.tag, child.attrs.reason);
        });
        sock.ws.on("CB:receipt", (node) => {
            if (!this.#engine || sock !== this.#sock)
                return;
            if (!isCallReceiptNode(node))
                return;
            this.#signaling.processIncomingReceipt(node, this.#engine, this.#activeCall?.callId ?? "");
        });
    };
    /**
     * The socket dropped after it had been open. Report offline at once (so no call is placed on a dead socket), end
     * a call in progress, and reopen unless WhatsApp said this session is over: logged out (401), replaced by another
     * session on the same credentials (440 — reopening would fight it), or the account is banned (403).
     */
    #handleSocketClosed = (error) => {
        this.#open = false;
        this.#activeCall?.end("disconnect");
        if (this.#closing)
            return;
        const statusCode = error?.output?.statusCode;
        const terminal = TERMINAL_DISCONNECT_REASONS.get(statusCode);
        if (terminal) {
            this.#giveUp(statusCode, terminal);
            return;
        }
        const rejected = SERVER_REJECT_REASONS.get(statusCode);
        this.#serverRejects = rejected ? this.#serverRejects + 1 : 0;
        if (rejected && this.#serverRejects >= SERVER_REJECT_LIMIT) {
            this.#giveUp(statusCode, rejected);
            return;
        }
        this.#disconnectReason = "reconnecting";
        console.warn(`WhatsApp socket closed (${statusCode ?? "unknown"}); reconnecting`, { authDir: this.#config.authDir });
        this.#scheduleReconnect();
    };
    #giveUp = (statusCode, reason) => {
        this.#disconnectReason = reason;
        console.error(`WhatsApp session ended (${statusCode} ${reason}); not reconnecting`, { authDir: this.#config.authDir });
    };
    #scheduleReconnect = () => {
        if (this.#closing || this.#reconnectTimer)
            return;
        const delay = RECONNECT_BACKOFF_MS[Math.min(this.#reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
        this.#reconnectAttempt += 1;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#reopenSocket();
        }, delay);
    };
    /** Opens a replacement socket from the same authDir (no QR); on open it is bound like the first one. */
    #reopenSocket = () => {
        if (this.#closing || !this.#createSocket)
            return;
        const sock = this.#createSocket();
        this.#sock = sock;
        sock.ev.on("connection.update", (update) => {
            if (sock !== this.#sock || this.#closing)
                return;
            if (update.connection === "open") {
                void this.#bindSocket(sock).then(() => {
                    if (sock !== this.#sock || this.#closing)
                        return;
                    this.#reconnectAttempt = 0;
                    this.#serverRejects = 0;
                    this.#disconnectReason = null;
                    this.#open = true;
                    console.warn("WhatsApp socket reconnected", { authDir: this.#config.authDir });
                }, (bindError) => {
                    console.error("WhatsApp socket reopened but could not be bound; retrying", bindError);
                    try {
                        sock.end?.(undefined);
                    }
                    catch { }
                });
                return;
            }
            if (update.connection === "close") {
                this.#handleSocketClosed(update.lastDisconnect?.error);
            }
        });
    };
    #handleCallEvent = (eventType, eventData) => {
        if (eventType === 16 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                const info = parsed.call_info ?? parsed.callInfo ?? {};
                const callState = Number(info.call_state ?? info.callState ?? 0);
                this.#activeCall?._updateState(callState);
            }
            catch { }
        }
        else if (eventType === 156 && eventData) {
            try {
                const update = JSON.parse(eventData);
                this.#relay?.updateRelayList(update);
            }
            catch { }
        }
        else if (eventType === 2) {
            this.#activeCall?._forceEnd("remote_end");
        }
        else if (eventType === 11) {
            this.#activeCall?._peerRejected();
        }
    };
    #handleAudioCaptureInit = (config) => {
        if (!this.#engine)
            return;
        this.#captureSampleRate = config.sampleRate || 16000;
        this.#captureChannels = config.channels || 1;
        this.#captureFramesPerChunk = config.framesPerChunk || 320;
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    };
    #handleAudioCaptureStart = () => {
        if (!this.#engine || !this.#capturePtr)
            return;
        const audioSource = this.#activeCall?._audioSource ?? "silence";
        this.#feeder = new AudioFeeder(this.#captureSampleRate, this.#captureChannels, this.#captureFramesPerChunk, (chunk) => {
            if (this.#engine && this.#capturePtr)
                this.#engine.sendAudioData(chunk, this.#capturePtr);
        }, audioSource);
        this.#feeder.start();
    };
    #handleAudioCaptureStop = () => {
        this.#feeder?.stop();
        this.#feeder = null;
        if (this.#engine && this.#capturePtr) {
            try {
                this.#engine.free(this.#capturePtr);
            }
            catch { }
            this.#capturePtr = 0;
        }
    };
}
